import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AttemptCall } from '@metro-labs/inference/attempts';
import { handleGatewayRequest, resetGatewayState, type GatewayDeps } from '@metro-labs/inference/gateway';
import type { ModelSetup } from '@metro-labs/inference/model-config';
import { connectionId, makeConnection, setupOf } from './model-fixture.ts';

const CANARY = 'canary-7f3e1b9a-never-kept';
const ANTHROPIC = connectionId('anthropic');
const OPENROUTER = connectionId('openrouter');

const usageStream = (res: ServerResponse): void => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(
    [
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":4000,"cache_creation_input_tokens":300,"cache_creation":{"ephemeral_5m_input_tokens":100,"ephemeral_1h_input_tokens":200},"output_tokens":1}}}',
      '',
      'event: content_block_delta',
      `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"${CANARY} \\"input_tokens\\": 999999"}}`,
      '',
      'event: message_delta',
      'data: {"type":"message_delta","usage":{"output_tokens":42}}',
      '',
      '',
    ].join('\n'),
  );
};

const brokenStream = (res: ServerResponse): void => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}\n\nevent: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n');
};

const limited = (res: ServerResponse): void => {
  res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '120' });
  res.end('{"type":"error","error":{"type":"rate_limit_error","message":"limit"}}');
};

const costed = (res: ServerResponse): void => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end('event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":7,"output_tokens":3,"cost":0.00123}}\n\n');
};

interface Upstream {
  server: Server;
  base: string;
}

async function upstream(answer: (model: string, res: ServerResponse) => void): Promise<Upstream> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      answer(String((JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: unknown }).model), res);
    });
  });
  await new Promise<void>((r) => {
    server.listen(0, '127.0.0.1', r);
  });
  return { server, base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` };
}

let anthropic: Upstream;
let openrouter: Upstream;
let gateway: Server;
let base = '';
let cfg: ModelSetup;
const calls: AttemptCall[] = [];

beforeAll(async () => {
  anthropic = await upstream((model, res) => {
    if (model === 'claude-limited') limited(res);
    else if (model === 'claude-broken') brokenStream(res);
    else usageStream(res);
  });
  openrouter = await upstream((_model, res) => {
    costed(res);
  });
  const deps: GatewayDeps = { setup: () => cfg, identify: (key) => key === 'mk_ok', anthropicBase: anthropic.base, openrouterBase: openrouter.base, onCall: (call) => calls.push(call) };
  gateway = createServer((req, res) => {
    if (!handleGatewayRequest(req, res, deps)) res.writeHead(404).end();
  });
  await new Promise<void>((r) => {
    gateway.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${String((gateway.address() as AddressInfo).port)}`;
});

afterAll(() => {
  for (const s of [anthropic.server, openrouter.server, gateway]) s.close();
});

beforeEach(() => {
  resetGatewayState();
  calls.length = 0;
});

const ask = async (model: string, path = '/v1/messages'): Promise<string> => {
  const res = await fetch(`${base}/gateway${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-metro-key': 'mk_ok' },
    body: JSON.stringify({ model, max_tokens: 8, stream: true, messages: [{ role: 'user', content: CANARY }] }),
  });
  return res.text();
};

const setupWith = (primary: string, fallback?: { connection: string; model: string }): ModelSetup => ({
  ...setupOf(ANTHROPIC, [makeConnection('anthropic', { apiKey: 'sk-ant-key' }), makeConnection('openrouter', { apiKey: 'or-key', model: 'openai/gpt-6' })], fallback === undefined ? [] : [fallback]),
  primary: { connection: ANTHROPIC, model: primary },
});

describe('every model request reports one call per attempt, with usage and never content', () => {
  test('a streamed answer reports its tokens, cache writes split by duration, and timings', async () => {
    cfg = setupWith('claude-sonnet-5-5');
    expect(await ask('claude-sonnet-5-5')).toContain(CANARY);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      connection: ANTHROPIC,
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      lane: 'main',
      kind: 'main',
      attempt: 0,
      status: 200,
      outcome: 'ok',
      tokens: { input: 12, output: 42, cacheRead: 4000, cacheWrite5m: 100, cacheWrite1h: 200 },
      providerCost: null,
    });
    expect(calls[0]?.ms).toBeGreaterThanOrEqual(0);
    expect(calls[0]?.firstTokenMs).not.toBeNull();
    expect(JSON.stringify(calls)).not.toContain(CANARY);
  });

  test('a 429 handed to a backup is two calls: rate_limited, then the backup with its own cost', async () => {
    cfg = setupWith('claude-limited', { connection: OPENROUTER, model: 'anthropic/claude-opus-5-5' });
    await ask('claude-limited');
    expect(calls.map((c) => [c.attempt, c.provider, c.status, c.outcome])).toEqual([
      [0, 'anthropic', 429, 'rate_limited'],
      [1, 'openrouter', 200, 'ok'],
    ]);
    expect(calls[1]).toMatchObject({ tokens: { input: 7, output: 3 }, providerCost: 0.00123 });
  });

  test('an error in the middle of a stream counts as a provider error', async () => {
    cfg = setupWith('claude-broken');
    await ask('claude-broken');
    expect(calls.map((c) => [c.status, c.outcome, c.tokens.input])).toEqual([[200, 'provider_error', 5]]);
  });

  test('counting tokens reports nothing', async () => {
    cfg = setupWith('claude-sonnet-5-5');
    await ask('claude-sonnet-5-5', '/v1/messages/count_tokens');
    expect(calls).toEqual([]);
  });
});
