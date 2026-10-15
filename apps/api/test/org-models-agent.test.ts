import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { signAgentRequest } from '@metro-labs/http/agent-signature';
import { leaveOrganization } from '@metro-labs/connectors/db/agent-keys';
import { routeText, type ModelRoute } from '@metro-labs/connectors/model-route';
import { modelDetailText, sealModelSecret, type ModelSecret } from '@metro-labs/connectors/model-secret';
import type { ModelConnectionRow } from '@metro-labs/connectors/db/models';
import { agents, modelConnections, modelRoutes } from '../src/db/schema.ts';
import { TEST_OWNER, TEST_STRANGER } from './identity-helper.ts';
import { PGLITE_START_MS, PGLITE_STEP_MS, testDb, type TestDb } from './pglite-db.ts';
import { agentCall, enrolled, idToken, json, provider, startApi, type Api, type Provider, type SignedAgent } from './org-models-fixture.ts';

const MODELS = '/api/agents/models';
const REFRESH = '/api/agents/models/refresh';
const IMPORT = '/api/agents/models/import';
const TOKEN = 'POST https://auth.openai.com/api/accounts/oauth/token';
const CODE_TOKEN = 'POST https://auth.openai.com/oauth/token';

let held: TestDb;
let api: Api;
let vendor: Provider;
let now = Date.now();
let ours: SignedAgent;

interface Delivered {
  route: ModelRoute | null;
  source: string | null;
  chatgptHostId: string;
  connections: { id: string; revision: number; credential: Record<string, unknown> | null; account: Record<string, unknown> }[];
}

const call = (path: string, body?: unknown, agent = ours, headers: Record<string, string> = {}): Promise<Response> => {
  now += 1;
  return agentCall(api, agent, path, body, now, headers);
};

const delivered = async (agent = ours): Promise<Delivered> => {
  const res = await call(MODELS, undefined, agent);
  expect(res.status).toBe(200);
  return (await res.json()) as Delivered;
};

async function seed(id: string, provider: string, secret: ModelSecret | null, patch: Partial<ModelConnectionRow> = {}): Promise<ModelConnectionRow> {
  const at = new Date(now).toISOString();
  const row: ModelConnectionRow = { id, owner: TEST_OWNER, provider, label: provider, model: 'model-a', region: '', zdr: false, secret: null, detail: null, revision: 1, importAgent: null, importId: null, createdBy: 'user:test', createdAt: at, updatedAt: at, ...patch };
  const key = api.models.key();
  if (key === null) throw new Error('no key');
  row.secret = secret === null ? null : sealModelSecret(key, row, secret);
  await held.db.insert(modelConnections).values(row);
  return row;
}

async function route(agent: string | null, value: ModelRoute, owner = TEST_OWNER): Promise<void> {
  await held.db.insert(modelRoutes).values({ id: `route${String(Math.random()).slice(2, 8)}`, owner, agent, route: routeText(value), updatedBy: 'user:test', updatedAt: new Date(now).toISOString() });
}

const codex = (expiresAt: number): ModelSecret => ({ kind: 'codex', method: 'chatgpt', accessToken: 'ACCESS_OLD', refreshToken: 'REFRESH_OLD', expiresAt, clientId: 'oaiapp_client', subject: 'user-sub' });

beforeAll(async () => {
  held = await testDb();
  vendor = provider();
  api = await startApi(() => held.db, () => now, vendor.fetch);
}, PGLITE_START_MS);

beforeEach(async () => {
  now = Date.now();
  vendor.sent.length = 0;
  vendor.replies.clear();
  await held.reset();
  ours = await enrolled(held.db, 'agent000001', TEST_OWNER);
}, PGLITE_STEP_MS);

afterAll(async () => {
  await api.close();
  await held.close();
});

describe('the delivered setup', () => {
  test('nothing set answers no route, and the organization keeps one ChatGPT host id', async () => {
    const first = await delivered();
    expect(first).toMatchObject({ route: null, source: null, connections: [] });
    expect(first.chatgptHostId).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect((await delivered()).chatgptHostId).toBe(first.chatgptHostId);
  });

  test('the organization default applies until an override exists, and only named connections are sent', async () => {
    await seed('conn0000001', 'openrouter', { kind: 'key', apiKey: 'sk-or-secret' }, { zdr: true });
    await seed('conn0000002', 'anthropic', { kind: 'key', apiKey: 'sk-ant-secret' });
    await route(null, { primary: { connection: 'conn0000001', model: 'openai/gpt-5.2' }, fallbacks: [] });
    const org = await delivered();
    expect(org.source).toBe('organization');
    expect(org.connections).toEqual([expect.objectContaining({ id: 'conn0000001', provider: 'openrouter', zdr: true, revision: 1, credential: { apiKey: 'sk-or-secret' } }) as unknown as Delivered['connections'][number]]);
    await route('agent000001', { primary: { connection: 'conn0000002', model: 'claude-sonnet-5-5' }, fallbacks: [{ connection: 'local:Xyz12345678', model: 'claude-haiku-4-5' }, { connection: 'local:session', model: '' }] });
    const own = await delivered();
    expect(own.source).toBe('agent');
    expect(own.route?.fallbacks.map((f) => f.connection)).toEqual(['local:Xyz12345678', 'local:session']);
    expect(own.connections.map((c) => c.id)).toEqual(['conn0000002']);
  });

  test('a signed-out connection carries no credential and no refresh token ever leaves', async () => {
    await seed('conn0000003', 'codex', codex(now + 3_600_000), { detail: modelDetailText({ method: 'chatgpt', email: 'a@example.com', signedOut: true }) });
    await route(null, { primary: { connection: 'conn0000003', model: 'gpt-5.2' }, fallbacks: [] });
    const answer = await delivered();
    expect(answer.connections[0]).toMatchObject({ credential: null, account: { email: 'a@example.com', plan: null, method: 'chatgpt' } });
    expect(JSON.stringify(answer)).not.toContain('REFRESH_OLD');
  });

  test('a browser, a replay, a moved agent and a removed key are refused', async () => {
    expect((await call(MODELS, undefined, ours, { origin: 'https://metro.box' })).status).toBe(403);
    now += 1;
    const authorization = signAgentRequest({ method: 'POST', host: api.host, path: MODELS, body: Buffer.alloc(0) }, ours.signing, ours.row.keyId, now);
    const send = (): Promise<Response> => fetch(`${api.base}${MODELS}`, { method: 'POST', headers: { authorization } });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(401);
    await held.db.update(agents).set({ owner: TEST_STRANGER }).where(eq(agents.id, 'agent000001'));
    const moved = await call(MODELS);
    expect(moved.status).toBe(401);
    expect(await moved.json()).toMatchObject({ code: 'agent_key_missing' });
    await held.db.update(agents).set({ owner: TEST_OWNER }).where(eq(agents.id, 'agent000001'));
    await held.db.transaction((tx) => leaveOrganization(tx, 'agent000001'));
    expect((await call(MODELS)).status).toBe(401);
  });

  test('without METRO_CONNECTORS_KEY delivery answers 503', async () => {
    const kept = api.models.key();
    api.setKey(null);
    try {
      expect((await call(MODELS)).status).toBe(503);
    } finally {
      api.setKey(kept);
    }
  });
});

describe('Codex refresh', () => {
  const answered = (access: string): Response => json({ access_token: access, refresh_token: 'REFRESH_NEW', expires_in: 3600, id_token: idToken({ email: 'new@example.com' }) });

  test('a delivery renews a token within five minutes of its end, once, with a new revision', async () => {
    await seed('conn0000004', 'codex', codex(now + 60_000));
    await route(null, { primary: { connection: 'conn0000004', model: 'gpt-5.2' }, fallbacks: [] });
    vendor.replies.set(TOKEN, () => answered('ACCESS_NEW'));
    const answer = await delivered();
    expect(answer.connections[0]).toMatchObject({ revision: 2, credential: { accessToken: 'ACCESS_NEW', method: 'chatgpt', accountId: null }, account: { email: 'new@example.com' } });
    expect(JSON.stringify(answer)).not.toContain('REFRESH');
    const form = new URLSearchParams(vendor.sent[0]?.body ?? '');
    expect(Object.fromEntries(form)).toEqual({ grant_type: 'refresh_token', client_id: 'oaiapp_client', refresh_token: 'REFRESH_OLD', resource: 'https://api.openai.com/v1' });
    await delivered();
    expect(vendor.sent).toHaveLength(1);
  });

  test('two forced refreshes of one revision make one call; a stale revision only reads', async () => {
    await seed('conn0000005', 'codex', codex(now + 3_600_000));
    await route(null, { primary: { connection: 'conn0000005', model: 'gpt-5.2' }, fallbacks: [] });
    const gate = Promise.withResolvers<void>();
    vendor.replies.set(TOKEN, async () => {
      await gate.promise;
      return answered('ACCESS_FORCED');
    });
    const both = Promise.all([call(REFRESH, { connection: 'conn0000005', revision: 1 }), call(REFRESH, { connection: 'conn0000005', revision: 1 })]);
    await Bun.sleep(100);
    gate.resolve();
    const answers = (await Promise.all((await both).map((res) => res.json()))) as Delivered['connections'];
    expect(answers.map((a) => a.revision)).toEqual([2, 2]);
    expect(answers.map((a) => a.credential?.accessToken)).toEqual(['ACCESS_FORCED', 'ACCESS_FORCED']);
    expect(vendor.sent).toHaveLength(1);
    const stale = (await (await call(REFRESH, { connection: 'conn0000005', revision: 1 })).json()) as Delivered['connections'][number];
    expect(stale.revision).toBe(2);
    expect(vendor.sent).toHaveLength(1);
  });

  test('a forced refresh within a minute of the last token answers the current one, and a later one renews again', async () => {
    await seed('conn0000008', 'codex', codex(now + 3_600_000));
    await route(null, { primary: { connection: 'conn0000008', model: 'gpt-5.2' }, fallbacks: [] });
    vendor.replies.set(TOKEN, () => answered('ACCESS_FORCED'));
    const ask = async (revision: number): Promise<Delivered['connections'][number]> => (await (await call(REFRESH, { connection: 'conn0000008', revision })).json()) as Delivered['connections'][number];
    expect((await ask(1)).revision).toBe(2);
    for (let i = 0; i < 3; i += 1) expect(await ask(2)).toMatchObject({ revision: 2, credential: { accessToken: 'ACCESS_FORCED' } });
    expect(vendor.sent).toHaveLength(1);
    now += 61_000;
    expect((await ask(2)).revision).toBe(3);
    expect(vendor.sent).toHaveLength(2);
  });

  test('a connection signed in less than a minute ago is not renewed by a forced refresh', async () => {
    await seed('conn0000009', 'codex', codex(now + 3_600_000), { detail: modelDetailText({ method: 'chatgpt', signedInAt: new Date(now).toISOString() }) });
    await route(null, { primary: { connection: 'conn0000009', model: 'gpt-5.2' }, fallbacks: [] });
    vendor.replies.set(TOKEN, () => answered('ACCESS_FORCED'));
    expect(await (await call(REFRESH, { connection: 'conn0000009', revision: 1 })).json()).toMatchObject({ revision: 1, credential: { accessToken: 'ACCESS_OLD' } });
    expect(vendor.sent).toHaveLength(0);
  });

  test('an invalid grant signs the connection out; a connection the route does not name is 404', async () => {
    await seed('conn0000006', 'codex', { kind: 'codex', method: 'code', accessToken: 'ACCESS_OLD', refreshToken: 'REFRESH_OLD', expiresAt: now + 3_600_000, accountId: 'acct-1' });
    await seed('conn0000007', 'openrouter', { kind: 'key', apiKey: 'sk-or' });
    await route(null, { primary: { connection: 'conn0000006', model: 'gpt-5.2' }, fallbacks: [] });
    vendor.replies.set(CODE_TOKEN, () => json({ error: { code: 'refresh_token_expired', message: 'expired' } }, 401));
    const res = await call(REFRESH, { connection: 'conn0000006', revision: 1 });
    expect(await res.json()).toMatchObject({ revision: 2, credential: null });
    expect(JSON.parse(vendor.sent[0]?.body ?? '{}')).toEqual({ client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', grant_type: 'refresh_token', refresh_token: 'REFRESH_OLD' });
    expect((await call(REFRESH, { connection: 'conn0000007', revision: 1 })).status).toBe(404);
    expect((await call(REFRESH, { connection: 'conn0000006' })).status).toBe(400);
  });
});

describe('the one-time import', () => {
  const body = {
    connections: [
      { id: 'oldOpenRout', provider: 'openrouter', label: 'OR', model: 'openai/gpt-5.2', region: '', zdr: true, apiKey: 'sk-or-imported' },
      { id: 'oldCodex001', provider: 'codex', label: '', model: 'gpt-5.2', codex: { accountId: 'acct-9', email: 'c@example.com', plan: 'pro', accessToken: 'ACC', refreshToken: 'REF', expiresAt: Date.now() + 3_600_000, savedAt: '2026-10-01T00:00:00.000Z' } },
      { id: 'oldKeyless1', provider: 'anthropic', model: '' },
      { id: 'oldClaude01', provider: 'anthropic', model: 'claude-opus-5-5', claude: { id: 'Login123456' } },
      { id: 'oldGemini01', provider: 'gemini', model: 'gemini-3' },
    ],
    route: 'oldCodex001',
    fallbacks: [{ connection: 'oldClaude01', model: 'claude-sonnet-5-5' }, { connection: 'oldKeyless1', model: 'claude-haiku-4-5' }, { connection: 'oldOpenRout', model: 'openai/gpt-5.2' }, { connection: 'oldGemini01', model: 'gemini-3' }],
  };

  test('maps ids, keeps local logins local, drops Gemini, sets the override, and a repeat changes nothing', async () => {
    const first = await call(IMPORT, body);
    expect(first.status).toBe(200);
    const { ids } = (await first.json()) as { ids: Record<string, string> };
    expect(ids.oldKeyless1).toBe('local:session');
    expect(ids.oldClaude01).toBe('local:Login123456');
    expect(ids.oldGemini01).toBeUndefined();
    expect(ids.oldOpenRout).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{10}$/);
    const again = (await (await call(IMPORT, body)).json()) as { ids: Record<string, string> };
    expect(again.ids).toEqual(ids);
    expect(await held.db.$count(modelConnections)).toBe(2);
    const answer = await delivered();
    expect(answer.source).toBe('agent');
    expect(answer.route).toEqual({
      primary: { connection: ids.oldCodex001 ?? '', model: 'gpt-5.2' },
      fallbacks: [{ connection: 'local:Login123456', model: 'claude-sonnet-5-5' }, { connection: 'local:session', model: 'claude-haiku-4-5' }, { connection: ids.oldOpenRout ?? '', model: 'openai/gpt-5.2' }],
    });
    const byId = new Map(answer.connections.map((c) => [c.id, c]));
    expect(byId.get(ids.oldCodex001 ?? '')).toMatchObject({ credential: { accessToken: 'ACC', method: 'code', accountId: 'acct-9' }, account: { email: 'c@example.com', plan: 'pro', method: 'code' } });
    expect(byId.get(ids.oldOpenRout ?? '')).toMatchObject({ credential: { apiKey: 'sk-or-imported' } });
  });

  test('a body with no connections is refused; bad rows are skipped and named, and the rest imports', async () => {
    expect((await call(IMPORT, { route: 'x' })).status).toBe(400);
    const res = await call(IMPORT, {
      connections: [{ id: 'bad', provider: 'openrouter' }, 'nope', { id: 'oldOther001', provider: 'mistral' }, body.connections[0]],
      route: 'oldOther001',
      fallbacks: [{ connection: 'oldOpenRout', model: 'openai/gpt-5.2' }, { connection: 'oldOther001', model: 'm' }],
    });
    expect(res.status).toBe(200);
    const answer = (await res.json()) as { ids: Record<string, string>; skipped: { id: string; reason: string }[] };
    expect(answer.skipped).toEqual([
      { id: 'bad', reason: 'it has no 11-character id' },
      { id: '', reason: 'it has no 11-character id' },
      { id: 'oldOther001', reason: 'its provider is not anthropic, bedrock, openrouter or codex' },
    ]);
    expect(Object.keys(answer.ids)).toEqual(['oldOpenRout']);
    expect((await delivered()).route).toEqual({ primary: { connection: answer.ids.oldOpenRout ?? '', model: 'openai/gpt-5.2' }, fallbacks: [] });
  });

  test('a connection with an API key and a Claude login imports as a key connection', async () => {
    const both = { id: 'oldBoth0001', provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-both', claude: { id: 'Login123456' } };
    const { ids } = (await (await call(IMPORT, { connections: [both], route: 'oldBoth0001' })).json()) as { ids: Record<string, string> };
    expect(ids.oldBoth0001).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{10}$/);
    const answer = await delivered();
    expect(answer.route?.primary).toEqual({ connection: ids.oldBoth0001 ?? '', model: 'claude-opus-5-5' });
    expect(answer.connections[0]).toMatchObject({ provider: 'anthropic', credential: { apiKey: 'sk-ant-both' } });
  });

  test('a route left empty by the import pins no override', async () => {
    const res = await call(IMPORT, { connections: [{ id: 'oldOther001', provider: 'mistral' }, body.connections[0]], route: 'oldOther001', fallbacks: [] });
    expect(res.status).toBe(200);
    expect(await held.db.$count(modelRoutes)).toBe(0);
    expect((await delivered()).source).toBeNull();
  });

  test('the organization limit counts only the rows that can be imported', async () => {
    for (let i = 0; i < 99; i += 1) await seed(`seed${String(i).padStart(7, '0')}`, 'openrouter', { kind: 'key', apiKey: 'sk-or' });
    const valid = (id: string): Record<string, unknown> => ({ id, provider: 'openrouter', model: 'm', apiKey: 'sk-or' });
    expect((await call(IMPORT, { connections: [valid('oldValid001'), valid('oldValid002')] })).status).toBe(409);
    expect(await held.db.$count(modelConnections)).toBe(99);
    const res = await call(IMPORT, { connections: [{ id: 'x', provider: 'openrouter' }, { id: 'oldOther001', provider: 'mistral' }, valid('oldValid001')] });
    expect(res.status).toBe(200);
    expect(await held.db.$count(modelConnections)).toBe(100);
  });
});
