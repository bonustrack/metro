import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleGatewayRequest, resetGatewayState } from '../src/gateway/gateway.ts';
import { forgetModelLists, LIST_TTL_MS, listCache, RETRY_MS } from '../src/gateway/model-lists.ts';
import { anthropicModels } from '../src/gateway/provider-models.ts';
import type { ModelConfig } from '../src/gateway/model-config.ts';
import { configOf, makeConnection } from './model-fixture.ts';
import { recordedClaudeModels, THINKING_OFF_REFUSAL } from './claude-models-fixture.ts';
import { settle, waitFor } from './wait.ts';

const LOGIN = 'Bearer sk-ant-oat-login';

interface Seen {
  method: string;
  url: string;
  auth: string;
  beta: string;
  body: Record<string, unknown>;
}

const seen: Seen[] = [];
let anthropic: Server;
let gateway: Server;
let anthropicBase = '';
let base = '';
let cfg: ModelConfig;
let loginValid = true;

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((r) => {
    server.listen(0, '127.0.0.1', r);
  });
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
};

beforeAll(async () => {
  anthropic = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const body = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
      seen.push({ method: req.method ?? '', url: req.url ?? '', auth: String(req.headers.authorization ?? ''), beta: String(req.headers['anthropic-beta'] ?? ''), body });
      if (req.method === 'GET' && (req.url ?? '').startsWith('/v1/models')) {
        const ok = loginValid && req.headers.authorization === LOGIN && String(req.headers['anthropic-beta']).includes('oauth-2025-04-20');
        res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
        res.end(ok ? JSON.stringify(recordedClaudeModels) : '{"type":"error","error":{"type":"authentication_error","message":"invalid token"}}');
        return;
      }
      const thinking = body.thinking as { type?: unknown } | undefined;
      if (body.model === 'claude-sonnet-5-5' && body.temperature !== undefined) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"type":"error","error":{"type":"invalid_request_error","message":"temperature is not supported"}}');
        return;
      }
      if (body.model === 'claude-sonnet-5-5' && thinking?.type === 'disabled') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(THINKING_OFF_REFUSAL);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', model: body.model }));
    });
  });
  anthropicBase = await listen(anthropic);
  gateway = createServer((req, res) => {
    if (handleGatewayRequest(req, res, { config: () => cfg, identify: (key) => key === 'mk_ok', anthropicBase })) return;
    res.writeHead(404).end();
  });
  base = await listen(gateway);
});

afterAll(() => {
  anthropic.close();
  gateway.close();
});

beforeEach(() => {
  resetGatewayState();
  forgetModelLists();
  seen.length = 0;
  loginValid = true;
  cfg = configOf('anthropic', [makeConnection('anthropic', { model: 'claude-sonnet-5-5' })]);
});

const post = (body: Record<string, unknown>, authorization = LOGIN): Promise<Response> =>
  fetch(`${base}/gateway/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-metro-key': 'mk_ok', authorization },
    body: JSON.stringify(body),
  });

const turn = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ model: 'claude-opus-5-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }], ...extra });

const keyless = makeConnection('anthropic');
const ids = async (): Promise<string[]> => (await anthropicModels(keyless, anthropicBase)).map((m) => m.id);
const listings = (): Seen[] => seen.filter((s) => s.method === 'GET');

async function until(check: () => Promise<boolean>, ms = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await check()) return;
    await settle(25);
  }
}

describe('the Anthropic model list without an API key', () => {
  test('is the built-in list until a Claude Code request carries the login, then the live list of that login, newest first', async () => {
    const known = await ids();
    expect(known[0]).toBe('claude-sonnet-5-5');
    expect(seen).toEqual([]);
    expect((await post(turn())).status).toBe(200);
    await until(async () => (await ids()).length === recordedClaudeModels.data.length);
    const live = await anthropicModels(keyless, anthropicBase);
    expect(live[0]).toEqual({ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' });
    expect(live.map((m) => m.id)).toEqual(recordedClaudeModels.data.map((m) => m.id));
    expect(listings()[0]?.auth).toBe(LOGIN);
    await post(turn());
    await waitFor(() => false, 50);
    expect(listings().length).toBe(1);
  });

  test('never uses the agent key metro stands in with, and keeps the built-in list when the login cannot list', async () => {
    cfg = configOf('anthropic', [makeConnection('anthropic')]);
    expect((await post(turn(), 'Bearer mk_ok')).status).toBe(403);
    await waitFor(() => false, 50);
    expect(seen).toEqual([]);
    loginValid = false;
    await post(turn());
    await waitFor(() => listings().length === 1);
    await waitFor(() => false, 50);
    expect(await ids()).toEqual(await anthropicModels(keyless, 'http://127.0.0.1:1').then((l) => l.map((m) => m.id)));
    await post(turn());
    await waitFor(() => false, 50);
    expect(listings().length).toBe(1);
  });
});

describe('a model list kept for an hour', () => {
  test('is reused while fresh, fetched again once stale, and kept when the provider then fails', async () => {
    let clock = 0;
    const cache = listCache<string>('test', () => clock);
    let calls = 0;
    const load = (list: string[]) => (): Promise<string[]> => {
      calls += 1;
      return Promise.resolve(list);
    };
    const fail = (): Promise<string[]> => Promise.reject(new Error('down'));
    await expect(cache.get('k', fail)).rejects.toThrow('down');
    expect(await cache.get('k', load(['a']))).toEqual(['a']);
    expect(await cache.get('k', load(['b']))).toEqual(['a']);
    clock = LIST_TTL_MS;
    expect(await cache.get('k', load(['b']))).toEqual(['b']);
    clock = 2 * LIST_TTL_MS;
    expect(await cache.get('k', fail)).toEqual(['b']);
    expect(cache.peek('k')).toEqual(['b']);
    expect(calls).toBe(2);
  });

  test('a background refresh runs only when the list is stale, and waits between failed tries', async () => {
    let clock = 0;
    const cache = listCache<string>('test', () => clock);
    let calls = 0;
    const failing = (): Promise<string[]> => {
      calls += 1;
      return Promise.reject(new Error('down'));
    };
    await cache.refresh('k', failing);
    await cache.refresh('k', failing);
    expect(calls).toBe(1);
    expect(cache.peek('k')).toBeNull();
    clock = RETRY_MS;
    await cache.refresh('k', () => Promise.resolve(['a']));
    expect(cache.peek('k')).toEqual(['a']);
    clock = RETRY_MS + LIST_TTL_MS - 1;
    await cache.refresh('k', failing);
    expect(calls).toBe(1);
  });
});

describe('a model that cannot run with thinking off', () => {
  test('is learned from its refusal, and the request goes again without that setting', async () => {
    const chore = turn({ thinking: { type: 'disabled' } });
    const res = await post(chore);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ model: 'claude-sonnet-5-5' });
    const sent = seen.filter((s) => s.method === 'POST');
    expect(sent.map((s) => s.body.model)).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5']);
    expect(sent.at(-1)?.body).not.toHaveProperty('thinking');
    seen.length = 0;
    expect((await post(chore)).status).toBe(200);
    expect(seen.length).toBe(1);
    expect(seen[0]?.body).not.toHaveProperty('thinking');
  });

  test('two requests racing on a model not learned yet both get through', async () => {
    const chore = turn({ thinking: { type: 'disabled' } });
    const answers = await Promise.all([post(chore), post(chore), post(chore)]);
    expect(answers.map((r) => r.status)).toEqual([200, 200, 200]);
  });

  test('any other refusal reaches Claude Code as it came, and teaches nothing', async () => {
    const res = await post(turn({ thinking: { type: 'disabled' }, temperature: 1 }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('temperature is not supported');
    seen.length = 0;
    await post(turn({ thinking: { type: 'disabled' } }));
    expect(seen.length).toBe(3);
  });
});
