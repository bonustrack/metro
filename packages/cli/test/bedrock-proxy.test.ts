import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { encodeFrame } from '../src/bedrock-eventstream.ts';
import {
  bedrockConfigFromEnv,
  errorKind,
  mapModel,
  regionPrefix,
  rewriteBody,
  startBedrockProxy,
  type BedrockConfig,
  type RunningProxy,
} from '../src/bedrock-proxy.ts';

const TOKEN = 'mb_test_token';
const CFG: BedrockConfig = { region: 'eu-central-2', bearerToken: 'bedrock-key', model: null };

interface Seen {
  url: string;
  authorization: string;
  accept: string;
  body: Record<string, unknown>;
}

let upstream: Server;
let proxy: RunningProxy;
let seen: Seen[] = [];
let script: ((req: Seen, res: ServerResponse) => void) | null = null;

const chunk = (event: object): Buffer =>
  encodeFrame(
    { ':message-type': 'event', ':event-type': 'chunk', ':content-type': 'application/json' },
    Buffer.from(JSON.stringify({ bytes: Buffer.from(JSON.stringify(event)).toString('base64') })),
  );

function streamOk(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' });
  res.write(chunk({ type: 'message_start', message: { id: 'msg_1', role: 'assistant' } }));
  res.write(chunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'pong' } }));
  res.end(chunk({ type: 'message_stop', 'amazon-bedrock-invocationMetrics': { outputTokenCount: 1 } }));
}

async function fake(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const entry: Seen = {
    url: req.url ?? '',
    authorization: req.headers.authorization ?? '',
    accept: req.headers.accept ?? '',
    body: JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>,
  };
  seen.push(entry);
  if (script !== null) {
    script(entry, res);
    return;
  }
  if (entry.url.endsWith('/invoke-with-response-stream')) streamOk(res);
  else if (entry.url.endsWith('/count-tokens')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"inputTokens":42}');
  } else {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"id":"msg_2","type":"message","content":[{"type":"text","text":"pong"}]}');
  }
}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    fake(req, res).catch(() => {
      res.end();
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  proxy = await startBedrockProxy(CFG, { token: TOKEN, upstream: base });
});

afterAll(async () => {
  await proxy.close();
  await new Promise<void>((r) => upstream.close(() => r()));
});

afterEach(() => {
  seen = [];
  script = null;
});

const call = (
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  token = TOKEN,
): Promise<Response> =>
  fetch(`http://127.0.0.1:${proxy.port}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const MESSAGE = { model: 'claude-sonnet-4-6', max_tokens: 8, messages: [{ role: 'user', content: 'Say pong' }] };

describe('model and region mapping', () => {
  test('a first-party id gets the region prefix and the anthropic. vendor segment', () => {
    expect(mapModel('claude-sonnet-4-6', CFG)).toBe('eu.anthropic.claude-sonnet-4-6');
    expect(regionPrefix('us-east-1')).toBe('us');
    expect(regionPrefix('ap-northeast-1')).toBe('apac');
    expect(regionPrefix('us-gov-west-1')).toBe('us-gov');
    expect(regionPrefix('sa-east-1')).toBe('global');
  });

  test('an id that is already a Bedrock id passes through untouched', () => {
    expect(mapModel('eu.anthropic.claude-sonnet-4-6', CFG)).toBe('eu.anthropic.claude-sonnet-4-6');
  });

  test('a pinned METRO_BEDROCK_MODEL wins over whatever Claude Code asked for', () => {
    expect(mapModel('claude-haiku-4-5', { ...CFG, model: 'eu.anthropic.claude-sonnet-4-6' })).toBe(
      'eu.anthropic.claude-sonnet-4-6',
    );
  });

  test('config refuses to start without a key or a region', () => {
    expect(() => bedrockConfigFromEnv({})).toThrow('AWS_BEARER_TOKEN_BEDROCK');
    expect(() => bedrockConfigFromEnv({ AWS_BEARER_TOKEN_BEDROCK: 'k' })).toThrow('region');
    expect(bedrockConfigFromEnv({ AWS_BEARER_TOKEN_BEDROCK: 'k', AWS_REGION: 'eu-central-2' })).toEqual({
      region: 'eu-central-2',
      bearerToken: 'k',
      model: null,
    });
  });
});

describe('request rewriting', () => {
  test('moves model into the url, drops stream, adds the Bedrock version and betas', () => {
    const out = rewriteBody({ ...MESSAGE, stream: true }, 'a-beta, b-beta', CFG);
    expect(out.modelId).toBe('eu.anthropic.claude-sonnet-4-6');
    expect(out.stream).toBe(true);
    expect(out.body.model).toBeUndefined();
    expect(out.body.stream).toBeUndefined();
    expect(out.body.anthropic_version).toBe('bedrock-2023-05-31');
    expect(out.body.anthropic_beta).toEqual(['a-beta', 'b-beta']);
    expect(out.body.max_tokens).toBe(8);
  });

  test('a body without a model is a 400 in Anthropic error shape', () => {
    expect(() => rewriteBody({ messages: [] }, undefined, CFG)).toThrow('model is required');
  });

  test('upstream statuses map onto Anthropic error types', () => {
    expect(errorKind(429, null)).toBe('rate_limit_error');
    expect(errorKind(400, 'ThrottlingException')).toBe('rate_limit_error');
    expect(errorKind(403, null)).toBe('permission_error');
    expect(errorKind(404, null)).toBe('not_found_error');
    expect(errorKind(500, null)).toBe('api_error');
  });
});

describe('the proxy over real HTTP', () => {
  test('a streaming call reaches Bedrock with the right url, auth and body, and comes back as SSE', async () => {
    const res = await call('/v1/messages', { ...MESSAGE, stream: true }, { 'anthropic-beta': 'interleaved-thinking-2025-05-14' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const text = await res.text();
    expect(text).toContain('event: message_start\ndata: {"type":"message_start"');
    expect(text).toContain('"text":"pong"');
    expect(text).toContain('event: message_stop');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('/model/eu.anthropic.claude-sonnet-4-6/invoke-with-response-stream');
    expect(seen[0]?.authorization).toBe('Bearer bedrock-key');
    expect(seen[0]?.accept).toBe('application/vnd.amazon.eventstream');
    expect(seen[0]?.body.anthropic_beta).toEqual(['interleaved-thinking-2025-05-14']);
    expect(seen[0]?.body.model).toBeUndefined();
  });

  test('a non-streaming call is passed through as JSON', async () => {
    const res = await call('/v1/messages', MESSAGE);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe('msg_2');
    expect(seen[0]?.url).toBe('/model/eu.anthropic.claude-sonnet-4-6/invoke');
  });

  test('a Bedrock refusal comes back in Anthropic error shape with the mapped type', async () => {
    script = (_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'x-amzn-errortype': 'ThrottlingException' });
      res.end('{"message":"Too many requests"}');
    };
    const res = await call('/v1/messages', MESSAGE);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'Too many requests' },
    });
  });

  test('a 400 with betas is retried once without them', async () => {
    script = (req, res) => {
      if (req.body.anthropic_beta !== undefined) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"message":"unknown beta"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"id":"msg_3"}');
    };
    const res = await call('/v1/messages', MESSAGE, { 'anthropic-beta': 'made-up-beta' });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.body.anthropic_beta).toEqual(['made-up-beta']);
    expect(seen[1]?.body.anthropic_beta).toBeUndefined();
  });

  test('an exception frame mid-stream becomes an SSE error event', async () => {
    script = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' });
      res.write(chunk({ type: 'message_start' }));
      res.end(
        encodeFrame(
          { ':message-type': 'exception', ':exception-type': 'modelStreamErrorException' },
          Buffer.from('{"message":"stream broke"}'),
        ),
      );
    };
    const text = await (await call('/v1/messages', { ...MESSAGE, stream: true })).text();
    expect(text).toContain('event: error\ndata: {"type":"error","error":{"type":"api_error","message":"stream broke"}}');
  });

  test('count_tokens uses Bedrock when it answers and estimates when it does not', async () => {
    const counted = await (await call('/v1/messages/count_tokens', MESSAGE)).json();
    expect(counted).toEqual({ input_tokens: 42 });
    script = (_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"message":"no"}');
    };
    const estimated = (await (await call('/v1/messages/count_tokens', MESSAGE)).json()) as { input_tokens: number };
    expect(estimated.input_tokens).toBeGreaterThan(0);
  });

  test('the wrong local token is refused before anything reaches Bedrock', async () => {
    const res = await call('/v1/messages', MESSAGE, {}, 'not-the-token');
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  test('anything but the two message routes is a 404 in Anthropic shape', async () => {
    const res = await call('/v1/models', {});
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe('not_found_error');
  });
});
