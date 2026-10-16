import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { openSecret } from '@metro-labs/connectors/secrets';
import { modelConnections } from '../src/db/schema.ts';
import { auth, TEST_OWNER } from './identity-helper.ts';
import { PGLITE_START_MS, PGLITE_STEP_MS, testDb, type TestDb } from './pglite-db.ts';
import { json, provider, startApi, type Api, type Provider, type Reply } from './org-models-fixture.ts';

const KEY = 'routeway-test-key';
const NEW_KEY = 'routeway-other-key';
const COUNT = 'POST https://api.routeway.ai/v1/messages/count_tokens';
const MODELS = 'GET https://api.routeway.ai/v1/models';
const TOKENS = { input_tokens: 8 };

let held: TestDb;
let api: Api;
let vendor: Provider;
let now = Date.parse('2026-10-17T08:00:00.000Z');

interface View {
  id: string;
  provider: string;
  label: string;
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

const add = (body: Record<string, unknown> = {}): Promise<Response> => call('POST', '/api/models', { provider: 'routeway', apiKey: KEY, ...body });

const page = (status: number): Response => new Response('<!DOCTYPE html><html><title>Just a moment...</title></html>', { status, headers: { 'content-type': 'text/html; charset=UTF-8' } });

const countReply = (reply: Reply): void => {
  vendor.replies.set(COUNT, reply);
};

function model(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `Lab: ${id}`,
    short_name: id.toUpperCase(),
    description: 'A model.',
    context_length: 1_000_000,
    created: 1_790_000_000,
    owned_by: 'lab',
    available: true,
    endpoints: ['/v1/chat/completions', '/v1/responses', '/v1/messages'],
    pricing: { input: { unit: '1M tokens', price_per_million_t: 2.0 }, output: { unit: '1M tokens', price_per_million_t: 10 }, caching: { read: { unit: '1M tokens', price_per_million_t: 0.2 } } },
    supported_parameters: ['max_completion_tokens', 'temperature', 'tool_choice', 'tools'],
    capabilities: { vision: true, function_call: true },
    ...extra,
  };
}

const LISTED = {
  object: 'list',
  data: [
    model('gpt-6.1-sol', { short_name: 'GPT 6.1 Sol', created: 1_790_640_000, context_length: 1_050_000 }),
    model('claude-haiku-5.5', { short_name: 'Claude Haiku 5.5', created: 0, pricing: { input: { price_per_million_t: 0.1 }, output: { price_per_million_t: '0.5' } } }),
    model('claude-sonnet-5.5', { short_name: '', name: 'Anthropic: Claude Sonnet 5.5', created: 1_790_553_600, context_length: null }),
    model('deepseek-v4-flash:free', { short_name: 'DeepSeek V4 Flash (free)', created: 1_780_000_000, pricing: { input: { price_per_million_t: 0 }, output: { price_per_million_t: 0 } } }),
    model('chat-only', { endpoints: ['/v1/chat/completions'] }),
    model('no-tools', { supported_parameters: ['temperature'] }),
    model('retired', { available: false }),
    { id: 'flux-2-dev', name: 'Flux 2 Dev', available: true, endpoints: ['/v1/images/generations'], pricing: { unit: 'per image', resolutions: { auto: 0.02 } } },
    'not a model',
  ],
};

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
}, PGLITE_STEP_MS);

afterAll(async () => {
  await api.close();
  await held.close();
});

describe('a Routeway key', () => {
  test('is checked with one free count_tokens call, then sealed as a key and never answered', async () => {
    countReply(() => json(TOKENS));
    const res = await add();
    expect(res.status).toBe(201);
    const { connection } = (await res.json()) as { connection: View };
    expect(connection).toMatchObject({ provider: 'routeway', label: 'Routeway', signedOut: false });
    expect(JSON.stringify(connection)).not.toContain(KEY);
    const [sent] = vendor.sent;
    expect(vendor.sent).toHaveLength(1);
    expect(sent?.headers.get('x-api-key')).toBe(KEY);
    expect(sent?.headers.get('authorization')).toBeNull();
    expect(sent?.headers.get('anthropic-version')).toBe('2023-06-01');
    expect(sent?.headers.get('user-agent')).toContain('metro');
    expect(JSON.parse(sent?.body ?? '{}')).toMatchObject({ model: 'claude-haiku-5.5' });
    const [row] = await held.db.select().from(modelConnections).where(eq(modelConnections.id, connection.id));
    expect(row?.secret).not.toContain(KEY);
    expect(openSecret(api.models.key() ?? Buffer.alloc(32), TEST_OWNER, connection.id, row?.secret ?? '', 'model')).toEqual({ kind: 'key', apiKey: KEY });
  });

  test('Routeway refusing it is a 400 and nothing is saved; no clear answer is a 503 and nothing is saved', async () => {
    const cases: [Reply, number, string][] = [
      [() => json({ error: { message: 'Invalid API key', type: 'authentication_error', code: 'invalid_api_key' } }, 401), 400, 'Routeway refused this key'],
      [() => json({ error: { message: 'No access', type: 'permission_error' } }, 403), 400, 'Routeway refused this key'],
      [() => page(403), 503, 'could not check this key'],
      [() => json({ error: { message: 'Too many failed authentication attempts.', type: 'rate_limit_error' } }, 429), 503, 'could not check this key'],
      [() => json({ error: { message: 'boom', type: 'api_error' } }, 500), 503, 'could not check this key'],
      [() => {
        throw new Error('connect ECONNREFUSED');
      }, 503, 'could not check this key'],
    ];
    for (const [reply, status, words] of cases) {
      countReply(reply);
      const res = await add();
      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: string }).error).toContain(words);
    }
    expect(await held.db.$count(modelConnections)).toBe(0);
  });

  test('any other answer from Routeway itself means the key got past its check, so it is kept', async () => {
    for (const status of [400, 402, 404, 422]) {
      countReply(() => json({ error: { message: 'not this request', type: 'invalid_request_error' } }, status));
      expect((await add()).status).toBe(201);
    }
  });

  test('a new key is checked before it replaces the old one; another provider’s key is not sent to Routeway', async () => {
    countReply(() => json(TOKENS));
    const { connection } = (await (await add()).json()) as { connection: View };
    countReply((sent) => (sent.headers.get('x-api-key') === NEW_KEY ? json({ error: { type: 'authentication_error' } }, 401) : json(TOKENS)));
    expect((await call('PATCH', `/api/models/${connection.id}`, { apiKey: NEW_KEY })).status).toBe(400);
    const [kept] = await held.db.select().from(modelConnections).where(eq(modelConnections.id, connection.id));
    expect(kept?.revision).toBe(1);
    countReply(() => json(TOKENS));
    expect((await call('PATCH', `/api/models/${connection.id}`, { apiKey: NEW_KEY })).status).toBe(200);
    const [moved] = await held.db.select().from(modelConnections).where(eq(modelConnections.id, connection.id));
    expect(moved?.revision).toBe(2);
    vendor.sent.length = 0;
    const or = (await (await call('POST', '/api/models', { provider: 'openrouter', apiKey: 'sk-or-v1-key' })).json()) as { connection: View };
    expect((await call('PATCH', `/api/models/${or.connection.id}`, { apiKey: 'sk-or-v1-other' })).status).toBe(200);
    expect(vendor.sent).toHaveLength(0);
  });
});

describe('the Routeway model list', () => {
  test('a challenge page or a broken answer is a 503, never a key refusal', async () => {
    countReply(() => json(TOKENS));
    const { connection } = (await (await add()).json()) as { connection: View };
    vendor.replies.set(MODELS, () => page(403));
    const challenged = await call('GET', `/api/models/${connection.id}/models`);
    expect(challenged.status).toBe(503);
    expect(((await challenged.json()) as { error: string }).error).toContain('Routeway would not list its models (403)');
    vendor.replies.set(MODELS, () => json({ object: 'list' }));
    expect((await call('GET', `/api/models/${connection.id}/models`)).status).toBe(503);
  });

  test('keeps the available tool models of the Messages endpoint, newest first, with prices per token and the context window, kept for an hour', async () => {
    countReply(() => json(TOKENS));
    const { connection } = (await (await add()).json()) as { connection: View };
    vendor.replies.set(MODELS, (sent) => (sent.headers.get('x-api-key') === null ? json(LISTED) : json({ error: 'the list is public' }, 400)));
    const res = await call('GET', `/api/models/${connection.id}/models`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: [
      { id: 'gpt-6.1-sol', name: 'GPT 6.1 Sol', price: { prompt: 2 / 1_000_000, completion: 10 / 1_000_000 }, context: 1_050_000 },
      { id: 'claude-sonnet-5.5', name: 'Anthropic: Claude Sonnet 5.5', price: { prompt: 2 / 1_000_000, completion: 10 / 1_000_000 } },
      { id: 'deepseek-v4-flash:free', name: 'DeepSeek V4 Flash (free)', price: { prompt: 0, completion: 0 }, context: 1_000_000 },
      { id: 'claude-haiku-5.5', name: 'Claude Haiku 5.5', price: { prompt: 0.1 / 1_000_000, completion: 0.5 / 1_000_000 }, context: 1_000_000 },
    ] });
    expect((await call('GET', `/api/models/${connection.id}/models`, undefined, await auth(TEST_OWNER, 'member'))).status).toBe(200);
    expect(vendor.sent.filter((sent) => sent.url.endsWith('/v1/models'))).toHaveLength(1);
    expect(vendor.sent.at(-1)?.headers.get('user-agent')).toContain('metro');
  });
});
