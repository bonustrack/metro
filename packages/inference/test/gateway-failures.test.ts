import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { randomInt } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { log } from '@metro-labs/core/log';
import { encodeFrame } from '@metro-labs/inference/eventstream';
import { handleGatewayRequest, resetGatewayState, type GatewayDeps } from '@metro-labs/inference/gateway';
import type { ModelSetup, Provider } from '@metro-labs/inference/model-config';
import { codexAccess, connectionId, makeConnection } from './model-fixture.ts';

const SECRET = 'the private plan for Tuesday';
const LONG = 'x'.repeat(500);

type Answer = (res: ServerResponse) => void;

const servers: Server[] = [];
let answer: Answer = (res) => res.writeHead(500).end();
let base = '';
let cfg: ModelSetup;
let warn: ReturnType<typeof spyOn<typeof log, 'warn'>>;

async function listen(server: Server): Promise<string> {
  const port = randomInt(10_000, 30_000);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  servers.push(server);
  return `http://127.0.0.1:${String(port)}`;
}

const sse = (res: ServerResponse, events: Record<string, unknown>[]): void => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of events) res.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
};

const exceptionFrame = (type: string, message: string): Buffer => encodeFrame({ ':message-type': 'exception', ':exception-type': type }, Buffer.from(JSON.stringify({ message })));

const connections = [
  makeConnection('anthropic', { apiKey: 'sk-ant-key', label: 'Anthropic team' }),
  makeConnection('bedrock', { apiKey: 'aws-key', region: 'eu-central-1', label: 'Bedrock EU' }),
  makeConnection('codex', { codex: codexAccess(), label: 'Codex (ChatGPT) 3' }),
  makeConnection('routeway', { apiKey: 'rw-key', label: 'Routeway' }),
];

const route = (provider: Provider, model: string): ModelSetup => ({ primary: { connection: connectionId(provider), model }, fallbacks: [], connections, source: 'organization' });

const body = (stream = true): Record<string, unknown> => ({ model: 'gpt-6.1-sol', max_tokens: 8, stream, messages: [{ role: 'user', content: SECRET }] });

async function ask(stream = true): Promise<string> {
  const res = await fetch(`${base}/gateway/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-metro-key': 'mk_ok' }, body: JSON.stringify(body(stream)) });
  return res.text();
}

const warned = (what: string): Record<string, unknown>[] =>
  warn.mock.calls.filter((call) => call[1] === what).map((call) => call[0] as Record<string, unknown>);

beforeAll(async () => {
  const upstream = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      answer(res);
    });
  });
  const at = await listen(upstream);
  const deps: GatewayDeps = {
    setup: () => cfg,
    identify: (key) => key === 'mk_ok',
    anthropicBase: at,
    bedrockBase: at,
    routewayBase: at,
    codex: { base: at, refresh: () => Promise.resolve(null) },
  };
  base = await listen(
    createServer((req, res) => {
      if (!handleGatewayRequest(req, res, deps)) res.writeHead(404).end();
    }),
  );
});

afterAll(() => {
  for (const server of servers) server.close();
});

beforeEach(() => {
  resetGatewayState();
  warn = spyOn(log, 'warn');
});

afterEach(() => {
  expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
  warn.mockRestore();
});

describe('a Codex response that fails is logged once with what Codex said', () => {
  test('a failed response names the connection, the model, the code and the message, cut at 300 characters', async () => {
    cfg = route('codex', 'gpt-6.1-sol');
    answer = (res) => sse(res, [{ type: 'response.created', response: { id: 'r' } }, { type: 'response.failed', response: { id: 'r', error: { code: 'server_error', message: LONG } } }]);
    expect(await ask()).toContain('"type":"error"');
    const [line] = warned('gateway: Codex did not complete the response');
    expect(line).toEqual({ connection: 'Codex (ChatGPT) 3', model: 'gpt-6.1-sol', code: 'server_error', message: 'x'.repeat(300) });
  });

  test('a stream that closes before it completes is logged, on a streamed and on a whole answer', async () => {
    cfg = route('codex', 'gpt-6.1-sol');
    answer = (res) => sse(res, [{ type: 'response.created', response: { id: 'r' } }]);
    await ask();
    await ask(false);
    expect(warned('gateway: Codex did not complete the response')).toEqual([
      { connection: 'Codex (ChatGPT) 3', model: 'gpt-6.1-sol', code: '', message: 'Codex ended the stream before completing the response' },
      { connection: 'Codex (ChatGPT) 3', model: 'gpt-6.1-sol', code: '', message: 'Codex ended the stream before completing the response' },
    ]);
  });

  test('a refusal before the stream is logged with its status, and a completed response logs nothing', async () => {
    cfg = route('codex', 'gpt-6.1-sol');
    answer = (res) => res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'invalid_prompt', message: 'Invalid prompt.' } }));
    await ask();
    expect(warned('gateway: Codex refused the request')).toEqual([{ connection: 'Codex (ChatGPT) 3', model: 'gpt-6.1-sol', code: 'invalid_prompt', message: 'Invalid prompt.', status: 400 }]);
    answer = (res) => sse(res, [{ type: 'response.created', response: { id: 'r' } }, { type: 'response.completed', response: { id: 'r' } }]);
    warn.mockClear();
    await ask();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('an error in the middle of an Anthropic-shaped stream is logged', () => {
  test('an error event from Anthropic is logged with its type and message, and the stream still reaches Claude Code as sent', async () => {
    cfg = route('anthropic', 'claude-opus-5-5');
    answer = (res) => sse(res, [{ type: 'message_start', message: { id: 'm' } }, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]);
    expect(await ask()).toContain('overloaded_error');
    expect(warned('gateway: the provider sent an error in the middle of its stream')).toEqual([{ connection: 'Anthropic team', model: 'claude-opus-5-5', code: 'overloaded_error', message: 'Overloaded' }]);
  });

  test('an exception in a Bedrock stream is logged the same way', async () => {
    cfg = route('bedrock', 'us.anthropic.claude-opus-5-5');
    answer = (res) => {
      res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' });
      res.end(exceptionFrame('ThrottlingException', 'Too many tokens, please wait before trying again.'));
    };
    expect(await ask()).toContain('rate_limit_error');
    expect(warned('gateway: the provider sent an error in the middle of its stream')).toEqual([
      { connection: 'Bedrock EU', model: 'us.anthropic.claude-opus-5-5', code: 'ThrottlingException', message: 'Too many tokens, please wait before trying again.' },
    ]);
  });
});

describe('a provider stream that ends before the answer is complete', () => {
  const toolStart = [
    { type: 'message_start', message: { id: 'm', usage: { input_tokens: 9, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'chatcmpl-tool-1', name: 'mcp__metro__react', input: {} } },
  ];
  const CUT = 'gateway: the provider ended its stream before the answer was complete';

  test('a Routeway stream cut after a tool call starts ends with an error, so Claude Code never runs the call without its arguments', async () => {
    cfg = route('routeway', 'glm-5.3-flash-uncensored');
    answer = (res) => sse(res, toolStart);
    const text = await ask();
    expect(text).toContain('chatcmpl-tool-1');
    expect(text.trimEnd().endsWith('}')).toBe(true);
    expect(text.slice(text.lastIndexOf('event: '))).toContain('"type":"api_error"');
    expect(text).toContain('ended its stream before the answer was complete');
    expect(warned(CUT)).toEqual([{ connection: 'Routeway', model: 'glm-5.3-flash-uncensored', code: 'stream_cut', message: '' }]);
  });

  test('an Anthropic stream cut the same way is closed with the same error', async () => {
    cfg = route('anthropic', 'claude-opus-5-5');
    answer = (res) => sse(res, toolStart);
    expect(await ask()).toContain('ended its stream before the answer was complete');
    expect(warned(CUT)).toHaveLength(1);
  });

  test('a complete stream, or one the provider already ended with an error, gets nothing added', async () => {
    cfg = route('routeway', 'glm-5.3-flash-uncensored');
    answer = (res) => sse(res, [...toolStart, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } }, { type: 'message_stop' }]);
    expect(await ask()).not.toContain('api_error');
    answer = (res) => sse(res, [...toolStart, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]);
    expect(await ask()).not.toContain('api_error');
    expect(warned(CUT)).toEqual([]);
  });
});
