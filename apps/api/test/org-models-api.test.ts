import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { openSecret } from '@metro-labs/connectors/secrets';
import { modelConnections } from '../src/db/schema.ts';
import { auth, TEST_OWNER, TEST_STRANGER } from './identity-helper.ts';
import { addAgent, PGLITE_START_MS, PGLITE_STEP_MS, testDb, type TestDb } from './pglite-db.ts';
import { json, provider, startApi, type Api, type Provider } from './org-models-fixture.ts';

const OURS = 'agent000001';
const THEIRS = 'agent000003';
const SECRET = 'sk-or-v1-very-secret-key';
const CLAUDE_TOKEN = `sk-ant-oat01-${'Ab3_-'.repeat(19)}AA`;
const NEW_TOKEN = `sk-ant-oat01-${'Zy9-_'.repeat(19)}AA`;

let held: TestDb;
let api: Api;
let vendor: Provider;
let now = Date.parse('2026-10-15T08:00:00.000Z');

interface View {
  id: string;
  provider: string;
  label: string;
  model: string;
  region: string;
  zdr: boolean;
  subscription: boolean;
  signedOut: boolean;
}

const call = async (method: string, path: string, body?: unknown, authorization?: string): Promise<Response> => {
  now += 1;
  return fetch(`${api.base}${path}`, {
    method,
    headers: { authorization: authorization ?? (await auth(TEST_OWNER)), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
};

const data = async <T>(res: Response): Promise<T> => (await res.json()) as T;

async function add(body: Record<string, unknown> = {}, authorization?: string): Promise<View> {
  const res = await call('POST', '/api/models', { provider: 'openrouter', apiKey: SECRET, model: 'openai/gpt-5.2', ...body }, authorization);
  expect(res.status).toBe(201);
  return (await data<{ connection: View }>(res)).connection;
}

const revisionOf = async (id: string): Promise<number | undefined> => (await held.db.select().from(modelConnections).where(eq(modelConnections.id, id)))[0]?.revision;

beforeAll(async () => {
  held = await testDb();
  vendor = provider();
  api = await startApi(() => held.db, () => now, vendor.fetch);
}, PGLITE_START_MS);

beforeEach(async () => {
  now += 60_000;
  vendor.sent.length = 0;
  vendor.replies.clear();
  await held.reset();
  await addAgent(held.db, OURS, TEST_OWNER);
  await addAgent(held.db, THEIRS, TEST_STRANGER);
}, PGLITE_STEP_MS);

afterAll(async () => {
  await api.close();
  await held.close();
});

describe('who may do what', () => {
  test('a member reads, only an admin writes, nobody signed out gets in', async () => {
    const member = await auth(TEST_OWNER, 'member');
    expect((await fetch(`${api.base}/api/models`)).status).toBe(401);
    const list = await call('GET', '/api/models', undefined, member);
    expect(list.status).toBe(200);
    expect(await data<unknown>(list)).toEqual({ connections: [], default: null, agents: {} });
    expect((await call('POST', '/api/models', { provider: 'openrouter', apiKey: SECRET }, member)).status).toBe(403);
    expect((await call('PUT', '/api/models/route', { agent: null, primary: null }, member)).status).toBe(403);
    expect((await call('POST', '/api/models/codex/login', {}, member)).status).toBe(403);
    expect((await call('PATCH', '/api/models/conn0000001', { label: 'x' }, member)).status).toBe(403);
    expect((await call('GET', '/api/models/nope/extra/path')).status).toBe(404);
    expect((await call('PUT', '/api/models')).status).toBe(405);
  });

  test('without METRO_CONNECTORS_KEY nothing that seals or opens a secret runs, the rest does', async () => {
    const made = await add();
    const kept = api.models.key();
    api.setKey(null);
    try {
      expect((await call('POST', '/api/models', { provider: 'openrouter', apiKey: SECRET })).status).toBe(503);
      expect((await call('PATCH', `/api/models/${made.id}`, { apiKey: 'sk-new' })).status).toBe(503);
      expect((await call('GET', `/api/models/${made.id}/models`)).status).toBe(503);
      expect((await call('POST', '/api/models/codex/login', {})).status).toBe(503);
      expect((await call('POST', '/api/models/openrouter/login', {})).status).toBe(503);
      expect((await call('PATCH', `/api/models/${made.id}`, { label: 'Renamed' })).status).toBe(200);
      expect((await call('GET', '/api/models')).status).toBe(200);
    } finally {
      api.setKey(kept);
    }
  });
});

describe('connections', () => {
  test('a key connection is sealed as a model secret and no answer carries it', async () => {
    const made = await add({ label: '', zdr: true });
    expect(made).toMatchObject({ provider: 'openrouter', label: 'OpenRouter', model: 'openai/gpt-5.2', zdr: true, signedOut: false });
    expect((await add()).label).toBe('OpenRouter 2');
    const listed = await call('GET', '/api/models');
    expect(JSON.stringify(await data<unknown>(listed))).not.toContain(SECRET);
    const row = (await held.db.select().from(modelConnections).where(eq(modelConnections.id, made.id)))[0];
    const key = api.models.key();
    if (row?.secret === null || row === undefined || key === null) throw new Error('not stored');
    expect(row.secret).not.toContain(SECRET);
    expect(openSecret(key, TEST_OWNER, made.id, row.secret, 'model')).toEqual({ kind: 'key', apiKey: SECRET });
    expect(() => openSecret(key, TEST_OWNER, made.id, row.secret ?? '')).toThrow('could not be opened');
  });

  test('bad input is refused with a sentence', async () => {
    expect((await call('POST', '/api/models', { provider: 'codex', apiKey: SECRET })).status).toBe(400);
    expect((await call('POST', '/api/models', { provider: 'gemini', apiKey: SECRET })).status).toBe(400);
    expect((await call('POST', '/api/models', { provider: 'openrouter' })).status).toBe(400);
    expect((await call('POST', '/api/models', { provider: 'bedrock', apiKey: 'k', region: 'evil.example.com/' })).status).toBe(400);
    const made = await add();
    expect((await call('PATCH', `/api/models/${made.id}`, { provider: 'anthropic' })).status).toBe(400);
    expect((await call('PATCH', `/api/models/${made.id}`, { label: '' })).status).toBe(400);
  });

  test('a rename keeps the revision, a new key moves it, another organization sees nothing', async () => {
    const made = await add();
    const renamed = await call('PATCH', `/api/models/${made.id}`, { label: 'Team OpenRouter', model: 'anthropic/claude-sonnet-5.5', zdr: true });
    expect(await data<{ connection: View }>(renamed)).toMatchObject({ connection: { label: 'Team OpenRouter', model: 'anthropic/claude-sonnet-5.5', zdr: true } });
    expect(await revisionOf(made.id)).toBe(1);
    expect((await call('PATCH', `/api/models/${made.id}`, { apiKey: 'sk-or-rotated' })).status).toBe(200);
    expect(await revisionOf(made.id)).toBe(2);
    const stranger = await auth(TEST_STRANGER);
    expect((await call('PATCH', `/api/models/${made.id}`, { label: 'x' }, stranger)).status).toBe(404);
    expect((await call('DELETE', `/api/models/${made.id}`, undefined, stranger)).status).toBe(404);
    expect(await data<unknown>(await call('GET', '/api/models', undefined, stranger))).toEqual({ connections: [], default: null, agents: {} });
  });
});

describe('Claude subscriptions', () => {
  const subscribe = async (body: Record<string, unknown> = {}): Promise<View> => {
    const res = await call('POST', '/api/models', { provider: 'anthropic', claudeToken: CLAUDE_TOKEN, ...body });
    expect(res.status).toBe(201);
    return (await data<{ connection: View }>(res)).connection;
  };

  test('a token from claude setup-token is sealed as its own kind and no answer carries it', async () => {
    const made = await subscribe({ label: '' });
    expect(made).toMatchObject({ provider: 'anthropic', label: 'Claude subscription', subscription: true, signedOut: false });
    expect((await subscribe()).label).toBe('Claude subscription 2');
    const keyed = await data<{ connection: View }>(await call('POST', '/api/models', { provider: 'anthropic', apiKey: 'sk-ant-api-key' }));
    expect(keyed.connection).toMatchObject({ label: 'Anthropic', subscription: false });
    expect(JSON.stringify(await data<unknown>(await call('GET', '/api/models')))).not.toContain(CLAUDE_TOKEN);
    const row = (await held.db.select().from(modelConnections).where(eq(modelConnections.id, made.id)))[0];
    const key = api.models.key();
    if (row?.secret === null || row === undefined || key === null) throw new Error('not stored');
    expect(row.secret).not.toContain(CLAUDE_TOKEN);
    expect(openSecret(key, TEST_OWNER, made.id, row.secret, 'model')).toEqual({ kind: 'claude', token: CLAUDE_TOKEN });
  });

  test('anything but a whole sk-ant-oat01- token is refused, and only on Anthropic', async () => {
    const refused = async (body: Record<string, unknown>): Promise<string> => {
      const res = await call('POST', '/api/models', { provider: 'anthropic', ...body });
      expect(res.status).toBe(400);
      return ((await res.json()) as { error: string }).error;
    };
    expect(await refused({ claudeToken: 'sk-ant-oat01-short' })).toContain('claude setup-token');
    expect(await refused({ claudeToken: CLAUDE_TOKEN.replace('oat01', 'api03') })).toContain('sk-ant-oat01-');
    expect(await refused({ claudeToken: `${CLAUDE_TOKEN} extra` })).toContain('sk-ant-oat01-');
    expect(await refused({ claudeToken: 42 })).toContain('sk-ant-oat01-');
    expect(await refused({ claudeToken: CLAUDE_TOKEN, apiKey: 'sk-ant-key' })).toContain('not both');
    expect(await refused({ provider: 'openrouter', claudeToken: CLAUDE_TOKEN })).toContain('Only an Anthropic connection');
    expect(await held.db.$count(modelConnections)).toBe(0);
  });

  test('signing in again replaces the token with a new revision, and a key and a token never swap', async () => {
    const made = await subscribe();
    expect((await call('PATCH', `/api/models/${made.id}`, { claudeToken: 'sk-ant-oat01-short' })).status).toBe(400);
    expect((await call('PATCH', `/api/models/${made.id}`, { apiKey: 'sk-ant-key' })).status).toBe(400);
    expect(await revisionOf(made.id)).toBe(1);
    const replaced = await call('PATCH', `/api/models/${made.id}`, { claudeToken: NEW_TOKEN, label: 'Max plan' });
    expect(await data<{ connection: View }>(replaced)).toMatchObject({ connection: { label: 'Max plan', subscription: true } });
    expect(await revisionOf(made.id)).toBe(2);
    const row = (await held.db.select().from(modelConnections).where(eq(modelConnections.id, made.id)))[0];
    const key = api.models.key();
    if (row?.secret === null || row === undefined || key === null) throw new Error('not stored');
    expect(openSecret(key, TEST_OWNER, made.id, row.secret, 'model')).toEqual({ kind: 'claude', token: NEW_TOKEN });
    const keyed = await data<{ connection: View }>(await call('POST', '/api/models', { provider: 'anthropic', apiKey: 'sk-ant-key' }));
    expect((await call('PATCH', `/api/models/${keyed.connection.id}`, { claudeToken: NEW_TOKEN })).status).toBe(400);
  });

  test('its models are listed with the token as a bearer, and the known Claude models stand in when Anthropic refuses', async () => {
    const made = await subscribe();
    vendor.replies.set('GET https://api.anthropic.com/v1/models', (sent) => sent.headers.get('authorization') === `Bearer ${CLAUDE_TOKEN}` && sent.headers.get('anthropic-beta') === 'oauth-2025-04-20' && !sent.headers.has('x-api-key')
      ? json({ data: [{ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', created_at: '2026-09-01' }] })
      : json({ error: 'no' }, 401));
    expect(await data<unknown>(await call('GET', `/api/models/${made.id}/models`))).toEqual({ models: [{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }] });
    await call('PATCH', `/api/models/${made.id}`, { claudeToken: NEW_TOKEN });
    const fallback = await data<{ models: { id: string }[] }>(await call('GET', `/api/models/${made.id}/models`));
    expect(fallback.models.map((m) => m.id)).toContain('claude-opus-5-5');
  });
});

describe('routes', () => {
  test('the default and an override name only connections of this organization, never a Claude login of a box', async () => {
    const or = await add();
    const theirs = await add({}, await auth(TEST_STRANGER));
    const primary = { connection: or.id, model: 'openai/gpt-5.2' };
    for (const local of [{ agent: null, primary, fallbacks: [{ connection: 'local:session', model: '' }] }, { agent: OURS, primary: { connection: 'local:Login123456', model: 'claude-opus-5-5' } }]) {
      const refused = await call('PUT', '/api/models/route', local);
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toContain('add a Claude subscription');
    }
    expect((await call('PUT', '/api/models/route', { agent: null, primary: { connection: theirs.id, model: 'm' } })).status).toBe(400);
    expect((await call('PUT', '/api/models/route', { agent: THEIRS, primary })).status).toBe(404);
    expect((await call('PUT', '/api/models/route', { agent: null, primary: { connection: or.id, model: '' } })).status).toBe(400);
    for (const missing of [{ agent: null, primary: null, fallbacks: [primary] }, { agent: OURS, fallbacks: [primary] }]) {
      const refused = await call('PUT', '/api/models/route', missing);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ error: 'A route needs a primary model. To remove a route, delete it.' });
    }
    const nine = Array.from({ length: 9 }, (_, i) => ({ connection: or.id, model: `m${String(i)}` }));
    expect((await call('PUT', '/api/models/route', { agent: null, primary, fallbacks: nine })).status).toBe(400);
    expect((await call('PUT', '/api/models/route', { agent: null, primary })).status).toBe(200);
    const override = { agent: OURS, primary: { connection: or.id, model: 'anthropic/claude-opus-5.5' }, fallbacks: [{ connection: or.id, model: 'openai/gpt-5.2' }, { connection: or.id, model: 'openai/gpt-5.2' }] };
    expect(await data<unknown>(await call('PUT', '/api/models/route', override))).toEqual({ agent: OURS, route: { primary: override.primary, fallbacks: [{ connection: or.id, model: 'openai/gpt-5.2' }] } });
    const view = await data<{ default: unknown; agents: Record<string, unknown> }>(await call('GET', '/api/models'));
    expect(view.default).toEqual({ primary, fallbacks: [] });
    expect(Object.keys(view.agents)).toEqual([OURS]);
  });

  test('removing a connection takes it out of every route, and an override can be removed', async () => {
    const or = await add();
    const second = await add();
    const third = await add();
    await call('PUT', '/api/models/route', { agent: null, primary: { connection: or.id, model: 'a' }, fallbacks: [{ connection: second.id, model: 'b' }, { connection: third.id, model: 'c' }] });
    await call('PUT', '/api/models/route', { agent: OURS, primary: { connection: second.id, model: 'b' }, fallbacks: [{ connection: or.id, model: 'a' }] });
    expect(await data<unknown>(await call('DELETE', `/api/models/${or.id}`))).toEqual({ id: or.id, deleted: true });
    const view = await data<{ default: unknown; agents: Record<string, unknown> }>(await call('GET', '/api/models'));
    expect(view.default).toEqual({ primary: { connection: second.id, model: 'b' }, fallbacks: [{ connection: third.id, model: 'c' }] });
    expect(view.agents[OURS]).toEqual({ primary: { connection: second.id, model: 'b' }, fallbacks: [] });
    await call('DELETE', `/api/models/${second.id}`);
    const after = await data<{ default: unknown; agents: Record<string, unknown> }>(await call('GET', '/api/models'));
    expect(after.default).toEqual({ primary: { connection: third.id, model: 'c' }, fallbacks: [] });
    expect(after.agents).toEqual({});
    await call('DELETE', `/api/models/${third.id}`);
    expect((await data<{ default: unknown }>(await call('GET', '/api/models'))).default).toBeNull();
    const fourth = await add();
    expect((await call('PUT', '/api/models/route', { agent: OURS, primary: { connection: fourth.id, model: 'd' } })).status).toBe(200);
    expect(await data<unknown>(await call('DELETE', `/api/models/route?agent=${OURS}`))).toEqual({ agent: OURS, deleted: true });
    expect((await data<{ agents: Record<string, unknown> }>(await call('GET', '/api/models'))).agents).toEqual({});
  });
});

describe('model lists', () => {
  test('OpenRouter lists tool models with prices and ZDR, kept for an hour', async () => {
    const or = await add();
    vendor.replies.set('GET https://openrouter.ai/api/v1/models', () => json({ data: [
      { id: 'openai/gpt-5.2', name: 'GPT-5.2', created: 2, pricing: { prompt: '0.000002', completion: '0.00001' }, supported_parameters: ['tools'] },
      { id: 'image/model', name: 'Image', created: 3, architecture: { output_modalities: ['image'] } },
      { id: 'old/model', name: 'Old', created: 1, supported_parameters: ['tools'] },
    ] }));
    vendor.replies.set('GET https://openrouter.ai/api/v1/endpoints/zdr', () => json({ data: [{ model_id: 'openai/gpt-5.2' }] }));
    const first = await data<{ models: unknown[] }>(await call('GET', `/api/models/${or.id}/models`));
    expect(first.models).toEqual([
      { id: 'openai/gpt-5.2', name: 'GPT-5.2', price: { prompt: 0.000002, completion: 0.00001 }, zdr: true },
      { id: 'old/model', name: 'Old', price: { prompt: null, completion: null }, zdr: false },
    ]);
    await call('GET', `/api/models/${or.id}/models`, undefined, await auth(TEST_OWNER, 'member'));
    expect(vendor.sent).toHaveLength(2);
  });

  test('Anthropic lists with the stored key, newest first, and a refused key is a 400', async () => {
    const res = await call('POST', '/api/models', { provider: 'anthropic', apiKey: 'sk-ant-key' });
    const { connection } = await data<{ connection: View }>(res);
    vendor.replies.set('GET https://api.anthropic.com/v1/models', (sent) => sent.headers.get('x-api-key') === 'sk-ant-key'
      ? json({ data: [{ id: 'claude-a', display_name: 'A', created_at: '2026-01-01' }, { id: 'claude-b', display_name: 'B', created_at: '2026-06-01' }] })
      : json({ error: 'no' }, 401));
    expect(await data<unknown>(await call('GET', `/api/models/${connection.id}/models`))).toEqual({ models: [{ id: 'claude-b', name: 'B' }, { id: 'claude-a', name: 'A' }] });
    await call('PATCH', `/api/models/${connection.id}`, { apiKey: 'sk-ant-wrong' });
    expect((await call('GET', `/api/models/${connection.id}/models`)).status).toBe(400);
  });
});
