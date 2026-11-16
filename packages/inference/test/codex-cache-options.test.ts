import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomInt } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { handleGatewayRequest, resetGatewayState, type GatewayDeps } from '@metro-labs/inference/gateway';
import type { ModelSetup } from '@metro-labs/inference/model-config';
import { codexAccess, connectionId, makeConnection } from './model-fixture.ts';

type Body = Record<string, unknown>;

const sent: Body[] = [];
const servers: Server[] = [];
let base = '';
let answer: (body: Body) => { status: number; text: string } = () => ({ status: 200, text: '' });

const usage = { input_tokens: 100, output_tokens: 7, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 30 } };
const completed = [
  { type: 'response.created', response: { id: 'r' } },
  { type: 'response.output_item.done', item: { id: 'm', type: 'message', content: [{ type: 'output_text', text: 'ok' }] } },
  { type: 'response.completed', response: { id: 'r', usage } },
].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');

const refusal = (param: string): string => JSON.stringify({ error: { message: `Unknown parameter: '${param}'.`, type: 'invalid_request_error', param, code: 'unknown_parameter' } });

async function listen(server: Server): Promise<string> {
  const port = randomInt(10_000, 30_000);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  servers.push(server);
  return `http://127.0.0.1:${String(port)}`;
}

const setup = (): ModelSetup => ({
  primary: { connection: connectionId('codex'), model: 'gpt-6.1-sol' },
  fallbacks: [],
  connections: [makeConnection('codex', { codex: codexAccess({ method: 'chatgpt' }) })],
  source: 'organization',
});

async function ask(): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}/gateway/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-metro-key': 'mk_ok', 'x-claude-code-session-id': '00aa40fe-af70-4e44-9868-2f81a5c380f6' },
    body: JSON.stringify({ model: 'codex:gpt-6.1-sol', max_tokens: 1000, stream: true, messages: [{ role: 'user', content: 'Hello' }] }),
  });
  return { status: res.status, text: await res.text() };
}

beforeAll(async () => {
  const upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body;
      sent.push(body);
      const reply = answer(body);
      if (reply.status !== 200) {
        res.writeHead(reply.status, { 'content-type': 'application/json' }).end(reply.text);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(completed);
    });
  });
  const at = await listen(upstream);
  const deps: GatewayDeps = { setup, identify: (key) => key === 'mk_ok', codex: { base: at, refresh: () => Promise.resolve(null) } };
  base = await listen(createServer((req, res) => {
    if (!handleGatewayRequest(req, res, deps)) res.writeHead(404).end();
  }));
});

afterAll(() => {
  for (const server of servers) server.close();
});

beforeEach(() => {
  resetGatewayState();
  sent.length = 0;
  answer = () => ({ status: 200, text: '' });
});

describe('the prompt cache on the official Continue with ChatGPT route', () => {
  test('asks for implicit breakpoints kept 12 hours (the code sign-in route is checked in gateway.test.ts)', async () => {
    expect((await ask()).status).toBe(200);
    expect(sent[0]?.prompt_cache_options).toEqual({ mode: 'implicit', ttl: '12h' });
  });

  test('when OpenAI refuses the field, the same request goes again without it, and the connection stops sending it', async () => {
    answer = (body) => (body.prompt_cache_options === undefined ? { status: 200, text: '' } : { status: 400, text: refusal('prompt_cache_options') });
    const first = await ask();
    expect(first.status).toBe(200);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.prompt_cache_options).toBeUndefined();
    expect(sent[1]?.input).toEqual(sent[0]?.input);
    expect((await ask()).status).toBe(200);
    expect(sent).toHaveLength(3);
    expect(sent[2]?.prompt_cache_options).toBeUndefined();
  });

  test('another refusal is passed on as it came, and asked only once', async () => {
    answer = () => ({ status: 400, text: refusal('tool_choice') });
    const refused = await ask();
    expect(refused.status).toBe(400);
    expect(refused.text).toContain('tool_choice');
    expect(sent).toHaveLength(1);
  });

  test('cache writes are reported apart from reads and fresh input', async () => {
    const answered = await ask();
    expect(answered.text).toContain('"input_tokens":50');
    expect(answered.text).toContain('"cache_read_input_tokens":20');
    expect(answered.text).toContain('"cache_creation_input_tokens":30');
  });
});
