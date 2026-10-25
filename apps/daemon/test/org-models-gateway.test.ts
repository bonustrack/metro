import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomInt } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { effectiveSetup } from '../src/gateway/effective.ts';
import { handleGatewayRequest, resetGatewayState } from '@metro-labs/inference/gateway';
import type { OrgModels } from '../src/gateway/org-models.ts';
import { deliveredRow, delivery, enrolledKey, fakeApi, keyCredential, orgModelsFor, type FakeApi } from './org-models-fixture.ts';

interface Seen {
  url: string;
  auth: string;
  beta: string;
  body: string;
}

const key = enrolledKey();
let api: FakeApi;
let models: OrgModels;
let provider: Server;
let gateway: Server;
let providerBase = '';
let base = '';
const seen: Seen[] = [];

const codexEvents = [
  { type: 'response.created', response: { id: 'resp_1' } },
  { type: 'response.output_item.added', item: { id: 'msg_1', type: 'message' } },
  { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Hi' },
  { type: 'response.output_item.done', item: { id: 'msg_1', type: 'message' } },
  { type: 'response.completed', response: { id: 'resp_1', usage: { input_tokens: 5, output_tokens: 1 } } },
];

function answer(req: IncomingMessage, res: ServerResponse, body: string): void {
  if ((req.url ?? '').startsWith('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}');
    return;
  }
  seen.push({ url: req.url ?? '', auth: String(req.headers.authorization ?? req.headers['x-api-key'] ?? ''), beta: String(req.headers['anthropic-beta'] ?? ''), body });
  if (req.headers.authorization === 'Bearer at-old') {
    res.writeHead(401, { 'content-type': 'application/json' }).end('{"detail":"expired"}');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (req.url === '/responses') for (const event of codexEvents) res.write(`data: ${JSON.stringify(event)}\n\n`);
  else res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  res.end();
}

async function listen(server: Server): Promise<string> {
  const port = randomInt(10000, 30000);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${String(port)}`;
}

const codexRow = (token: string, revision: number): Record<string, unknown> =>
  deliveredRow('cx000000001', 'codex', { revision, model: 'gpt-5.4', credential: { accessToken: token, expiresAt: Date.now() + 60_000, method: 'chatgpt', accountId: null } });

beforeAll(async () => {
  api = await fakeApi(key);
  provider = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      answer(req, res, Buffer.concat(chunks).toString('utf8'));
    });
  });
  providerBase = await listen(provider);
  gateway = createServer((req, res) => {
    const handled = handleGatewayRequest(req, res, {
      setup: () => effectiveSetup(models.current()),
      identify: (k) => k === 'mk_ok',
      anthropicBase: providerBase,
      openrouterBase: providerBase,
      codex: { base: providerBase, refresh: (c) => models.refresh(c) },
    });
    if (!handled) res.writeHead(404).end();
  });
  base = await listen(gateway);
});

afterAll(async () => {
  await api.close();
  for (const server of [provider, gateway]) server.close();
});

beforeEach(() => {
  resetGatewayState();
  seen.length = 0;
  api.asked.length = 0;
  api.answer = null;
  models = orgModelsFor(api, key);
});

const post = (model: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${base}/gateway/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-metro-key': 'mk_ok', ...headers },
    body: JSON.stringify({ model, max_tokens: 8, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });

describe('the gateway on the setup the organization delivered', () => {
  test('a key connection is sent with the delivered key and the route model', async () => {
    api.delivery = delivery({ connection: 'or000000001', model: 'openai/gpt-5.2' }, [deliveredRow('or000000001', 'openrouter', { credential: keyCredential('sk-or-secret') })]);
    await models.sync();
    const res = await post('claude-sonnet-5');
    expect(res.status).toBe(200);
    await res.text();
    expect(seen[0]).toMatchObject({ url: '/v1/messages', auth: 'Bearer sk-or-secret' });
    expect((JSON.parse(seen[0]?.body ?? '{}') as { model: string }).model).toBe('openai/gpt-5.2');
  });

  test('two requests hitting an expired Codex token share ONE renewal from api.metro.box, then both are answered', async () => {
    api.delivery = delivery({ connection: 'cx000000001', model: 'gpt-5.4' }, [codexRow('at-old', 3)]);
    api.answer = (path) => (path === '/api/agents/models/refresh' ? { status: 200, body: codexRow('at-new', 4) } : null);
    await models.sync();
    const [a, b] = await Promise.all([post('claude-sonnet-5'), post('claude-sonnet-5')]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await a.text()).toContain('"text":"Hi"');
    await b.text();
    expect(api.asked.filter((x) => x.path === '/api/agents/models/refresh').map((x) => x.body)).toEqual([{ connection: 'cx000000001', revision: 3 }]);
    expect(seen.filter((s) => s.auth === 'Bearer at-new')).toHaveLength(2);
    const later = await post('claude-sonnet-5');
    await later.text();
    expect(seen.at(-1)?.auth).toBe('Bearer at-new');
  });

  test('a signed-out Codex connection is refused with a sentence, and nothing reaches the provider', async () => {
    api.delivery = delivery({ connection: 'cx000000001', model: 'gpt-5.4' }, [deliveredRow('cx000000001', 'codex', { model: 'gpt-5.4' })]);
    await models.sync();
    const res = await post('claude-sonnet-5');
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Gateway page');
    expect(seen).toHaveLength(0);
  });

  test('a delivered Claude subscription is sent with its token and the oauth beta, and an unenrolled box serves no model at all', async () => {
    const token = `sk-ant-oat01-${'i'.repeat(80)}`;
    api.delivery = delivery({ connection: 'an000000001', model: 'claude-opus-5-5' }, [deliveredRow('an000000001', 'anthropic', { credential: { claudeToken: token } })], [], 'agent');
    await models.sync();
    await (await post('claude-sonnet-5', { authorization: 'Bearer sk-ant-oat-session' })).text();
    expect(seen[0]).toMatchObject({ url: '/v1/messages', auth: `Bearer ${token}`, beta: 'oauth-2025-04-20' });
    expect((JSON.parse(seen[0]?.body ?? '{}') as { model: string }).model).toBe('claude-opus-5-5');
    models = orgModelsFor(api, null);
    await models.sync();
    const res = await post('claude-sonnet-5', { authorization: 'Bearer sk-ant-oat-session' });
    expect(res.status).toBe(503);
    expect(seen).toHaveLength(1);
  });
});
