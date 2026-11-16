import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PGlite } from '@electric-sql/pglite';
import { log } from '@metro-labs/core/log';
import type { Database } from '@metro-labs/connectors/db/database';
import { modelCalls } from '@metro-labs/connectors/db/schema';
import { quietProviderText } from '@metro-labs/inference/failures';
import { addBox, addConnection, addKey, addRemote, listen, PGLITE_START_MS, setRoute, startApp, testDb, type TestApp } from './helpers.ts';

const CANARY = 'canary-5d1c8e72-never-kept';
const BOX = 'agent000001';
const REMOTE = 'remote00001';
const LONELY = 'remote00002';
const CONN = 'conn0000001';
const CONN_KEY = 'sk-ant-api-test-0001';
const CODEX = 'conn0000002';

interface Seen {
  model: string;
  headers: IncomingMessage['headers'];
  body: string;
}

const seen: Seen[] = [];

function answer(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const model = String((JSON.parse(body) as { model?: unknown }).model);
    seen.push({ model, headers: req.headers, body });
    if (req.url === '/responses') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(['{"type":"response.created","response":{"id":"resp_1"}}', '{"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":5,"output_tokens":1}}}'].map((data) => `data: ${data}\n\n`).join(''));
      return;
    }
    if (model === 'claude-broken') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `prompt contains ${CANARY}` } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      [
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":4000,"cache_creation_input_tokens":300,"cache_creation":{"ephemeral_5m_input_tokens":100,"ephemeral_1h_input_tokens":200},"output_tokens":1}}}',
        '',
        'event: content_block_delta',
        `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"${CANARY}"}}`,
        '',
        'event: message_delta',
        'data: {"type":"message_delta","usage":{"output_tokens":42}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
        '',
      ].join('\n'),
    );
  });
}

let held: { db: Database; client: PGlite };
let upstream: { server: import('node:http').Server; base: string };
let app: TestApp;
let boxToken = '';
let gatewayKey = { key: '', id: '' };
let connectorsKey = { key: '', id: '' };

beforeAll(async () => {
  quietProviderText();
  held = await testDb();
  upstream = await listen(answer);
}, PGLITE_START_MS);

beforeEach(async () => {
  await held.client.exec('TRUNCATE "model_calls", "model_routes", "model_connections", "agent_tokens", "agent_keys", "agents" CASCADE');
  seen.length = 0;
  boxToken = await addBox(held.db, BOX);
  await addRemote(held.db, REMOTE);
  await addRemote(held.db, LONELY);
  gatewayKey = await addKey(held.db, REMOTE, ['gateway']);
  connectorsKey = await addKey(held.db, REMOTE, ['connectors']);
  await addConnection(held.db, CONN, 'anthropic', { kind: 'key', apiKey: CONN_KEY });
  await setRoute(held.db, { primary: { connection: CONN, model: 'claude-sonnet-5-5' }, fallbacks: [] });
  await setRoute(held.db, { primary: { connection: CONN, model: 'claude-broken' }, fallbacks: [] }, LONELY);
  app = await startApp(held.db, { anthropicBase: upstream.base, codex: { base: upstream.base } });
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  upstream.server.close();
  await held.client.close();
});

const ask = (headers: Record<string, string>, model: string, path = '/v1/messages'): Promise<Response> =>
  fetch(`${app.base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...headers },
    body: JSON.stringify({ model, max_tokens: 64, stream: true, messages: [{ role: 'user', content: CANARY }] }),
  });

async function rows(): Promise<(typeof modelCalls.$inferSelect)[]> {
  await app.deps.calls.drain();
  return held.db.select().from(modelCalls);
}

describe('who may use gateway.metro.box', () => {
  test('no key, an unknown key and a key without the gateway scope get 401, and reach no provider', async () => {
    expect((await ask({}, 'metro')).status).toBe(401);
    expect((await ask({ 'x-api-key': `mcp_${'A'.repeat(43)}` }, 'metro')).status).toBe(401);
    expect((await ask({ 'x-api-key': connectorsKey.key }, 'metro')).status).toBe(401);
    expect(seen).toEqual([]);
  });

  test('a gateway key works in x-api-key or as a bearer, and never reaches the provider', async () => {
    const both: Record<string, string>[] = [{ 'x-api-key': gatewayKey.key }, { authorization: `Bearer ${gatewayKey.key}` }];
    for (const headers of both) {
      const res = await ask(headers, 'metro');
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(CANARY);
    }
    expect(seen.map((s) => [s.model, s.headers['x-api-key']])).toEqual([
      ['claude-sonnet-5-5', CONN_KEY],
      ['claude-sonnet-5-5', CONN_KEY],
    ]);
    for (const s of seen) expect(JSON.stringify(s.headers)).not.toContain(gatewayKey.key);
  });

  test('a key names a Metro model; anything else is a 400 that says which', async () => {
    const res = await ask({ 'x-api-key': gatewayKey.key }, 'claude-opus-5-5');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('Use the model "metro" (this agent\'s main models) or "metro-workers" (its worker models).');
    const models = (await (await fetch(`${app.base}/v1/models`, { headers: { 'x-api-key': gatewayKey.key } })).json()) as { data: { id: string }[] };
    expect(models.data.map((m) => m.id)).toEqual(['metro', 'metro-workers']);
  });
});

describe('usage, never content', () => {
  test('a key call is one row with its tokens, cost and key, and the prompt and answer are nowhere', async () => {
    const logged: unknown[] = [];
    const spies = [spyOn(log, 'info'), spyOn(log, 'warn'), spyOn(log, 'debug')].map((spy) => spy.mockImplementation((...args: unknown[]) => { logged.push(args); }));
    try {
      await (await ask({ 'x-api-key': gatewayKey.key }, 'metro')).text();
      const [row] = await rows();
      expect(row).toMatchObject({
        owner: 'org_01TESTOWNER000000',
        agent: REMOTE,
        agentName: 'Dashboard',
        origin: 'key',
        token: gatewayKey.id,
        lane: 'main',
        kind: 'external',
        connection: CONN,
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        attempt: 0,
        outcome: 'ok',
        status: 200,
        inputTokens: 12,
        outputTokens: 42,
        cacheReadTokens: 4000,
        cacheWrite5mTokens: 100,
        cacheWrite1hTokens: 200,
        costMicros: 2294,
        effort: null,
      });
      expect(JSON.stringify(await held.db.select().from(modelCalls))).not.toContain(CANARY);
      expect(JSON.stringify(logged)).not.toContain(CANARY);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  test('a box keeps its own model names and is recorded as the box', async () => {
    await (await ask({ authorization: `Bearer ${boxToken}` }, 'claude-sonnet-5-5')).text();
    const [row] = await rows();
    expect(row).toMatchObject({ agent: BOX, agentName: 'Lisa', origin: 'box', token: null, kind: 'main', outcome: 'ok' });
  });

  test('a provider refusal is recorded without its message, which never reaches a log line', async () => {
    const logged: unknown[] = [];
    const spy = spyOn(log, 'warn').mockImplementation((...args: unknown[]) => { logged.push(args); });
    try {
      const lonely = await addKey(held.db, LONELY, ['gateway']);
      const res = await ask({ 'x-api-key': lonely.key }, 'metro');
      expect(res.status).toBe(400);
      expect((await rows()).map((r) => [r.agent, r.outcome, r.status])).toEqual([[LONELY, 'refused', 400]]);
      expect(JSON.stringify(logged)).not.toContain(CANARY);
    } finally {
      spy.mockRestore();
    }
  });

  test('an agent with no model order gets a 503 and a no_route row', async () => {
    await held.client.exec('DELETE FROM "model_routes"');
    const res = await ask({ 'x-api-key': gatewayKey.key }, 'metro');
    expect(res.status).toBe(503);
    await res.text();
    expect((await rows()).map((r) => [r.outcome, r.connection, r.status, r.effort])).toEqual([['no_route', null, 503, null]]);
  });

  test('counting tokens is not recorded', async () => {
    await (await ask({ authorization: `Bearer ${boxToken}` }, 'claude-sonnet-5-5', '/v1/messages/count_tokens')).text();
    expect(await rows()).toEqual([]);
  });
});

describe('a Codex call that asks no effort', () => {
  test("gets the route's level for the model its key names, and a box's main thread gets the main level", async () => {
    await addConnection(held.db, CODEX, 'codex', { kind: 'codex', method: 'chatgpt', accessToken: 'codex-at-1', refreshToken: 'codex-rt-1', expiresAt: Date.now() + 7 * 86_400_000, clientId: 'app_test' }, 'gpt-6.1-sol');
    await held.client.exec('DELETE FROM "model_routes"');
    await setRoute(held.db, { primary: { connection: CODEX, model: 'gpt-6.1-sol' }, fallbacks: [] });
    for (const model of ['metro', 'metro-workers']) expect((await (await ask({ 'x-api-key': gatewayKey.key }, model)).text()).length).toBeGreaterThan(0);
    await (await ask({ authorization: `Bearer ${boxToken}` }, 'codex:gpt-6.1-sol')).text();
    expect(seen.map((s) => [s.model, (JSON.parse(s.body) as { reasoning?: { effort?: string } }).reasoning?.effort])).toEqual([
      ['gpt-6.1-sol', 'low'],
      ['gpt-6.1-sol', 'xhigh'],
      ['gpt-6.1-sol', 'low'],
    ]);
    expect((await rows()).map((r) => [r.provider, r.kind, r.outcome, r.effort]).sort()).toEqual([
      ['codex', 'external', 'ok', 'low'],
      ['codex', 'external', 'ok', 'xhigh'],
      ['codex', 'main', 'ok', 'low'],
    ]);
  });
});

describe('the Codex cache key of a caller that names no Claude Code session', () => {
  const sentKeys = (): { key: string; session: unknown }[] =>
    seen.map((s) => ({ key: (JSON.parse(s.body) as { prompt_cache_key: string }).prompt_cache_key, session: s.headers['session-id'] }));

  test('stays the same for one access key and one model, differs between keys and models, and a box session keeps its own', async () => {
    process.env.METRO_CODEX_REGISTRY = 'http://127.0.0.1:9/';
    try {
      await addConnection(held.db, CODEX, 'codex', { kind: 'codex', method: 'code', accessToken: 'codex-at-1', refreshToken: 'codex-rt-1', expiresAt: Date.now() + 7 * 86_400_000, accountId: 'acct_1' }, 'gpt-6.1-sol');
      await held.client.exec('DELETE FROM "model_routes"');
      await setRoute(held.db, { primary: { connection: CODEX, model: 'gpt-6.1-sol' }, fallbacks: [] });
      const other = await addKey(held.db, REMOTE, ['gateway']);
      const keyCalls = [[gatewayKey.key, 'metro'], [gatewayKey.key, 'metro'], [other.key, 'metro'], [gatewayKey.key, 'metro-workers']] as const;
      for (const [key, model] of keyCalls) await (await ask({ 'x-api-key': key }, model)).text();
      await (await ask({ authorization: `Bearer ${boxToken}`, 'x-claude-code-session-id': 'sess-box' }, 'codex:gpt-6.1-sol')).text();
      await (await ask({ authorization: `Bearer ${boxToken}` }, 'codex:gpt-6.1-sol')).text();
      await (await ask({ authorization: `Bearer ${boxToken}` }, 'codex:gpt-6.1-sol')).text();
      const [first, again, otherKey, workers, session, box, boxAgain] = sentKeys();
      for (const one of sentKeys()) expect(one.session).toBe(one.key);
      expect(again?.key).toBe(first?.key ?? '');
      expect(first?.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
      for (const secret of [gatewayKey.key, gatewayKey.id, REMOTE]) expect(first?.key).not.toContain(secret);
      expect(new Set([first?.key, otherKey?.key, workers?.key, box?.key]).size).toBe(4);
      expect(session?.key).toBe('sess-box');
      expect(boxAgain?.key).toBe(box?.key ?? '');
    } finally {
      delete process.env.METRO_CODEX_REGISTRY;
    }
  });
});
