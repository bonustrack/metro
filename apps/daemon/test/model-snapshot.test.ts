import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { IncomingMessage, ServerResponse, type OutgoingHttpHeaders } from 'node:http';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ids from '@metro-labs/core/ids';
import * as secureFs from '@metro-labs/core/secure-fs';
import { setBearerSessions } from '@metro-labs/http/api-http';
import { handleModelRequest, type ModelApiDeps } from '../src/gateway/model-api.js';
import type { ModelConfig } from '../src/gateway/model-config.js';
import { settingsBody } from '../src/gateway/model-store.js';
import { forgetServed, noteServed } from '../src/gateway/served.js';
import { forgetUsage, noteUsage, tallyTokens } from '../src/gateway/usage.js';
import * as usageRefresh from '../src/gateway/usage-refresh.js';
import { makeConnection } from './model-fixture.js';

const SNAPSHOT = '/api/model/snapshot';
const AUTH = 'Bearer snapshot-member';
const AT = '2026-01-01T00:00:00.000Z';
const dirs: string[] = [];
let previousAgents: string | undefined;
let stored: ModelConfig;
const read = mock((): ModelConfig => stored);
const write = mock((_cfg: ModelConfig): void => { throw new Error('unexpected model write'); });
const claudeUsage = mock((): Promise<unknown> => Promise.reject(new Error('unexpected Claude usage probe')));

beforeEach(() => {
  previousAgents = process.env.METRO_AGENTS_DIR;
  spyOn(ids, 'newId');
  spyOn(secureFs, 'writeSecure');
  forgetServed();
  forgetUsage();
  read.mockClear();
  write.mockClear();
  claudeUsage.mockClear();
  setBearerSessions((req) => Promise.resolve(req.headers.authorization === AUTH ? { subject: 'snapshot-owner', role: 'member' } : null));
  spyOn(usageRefresh, 'refreshUsage').mockRejectedValue(new Error('unexpected usage refresh'));
  spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network request'));
  stored = {
    version: 2,
    route: 'claude-first',
    connections: [
      makeConnection('anthropic', { id: 'claude-first', model: 'claude-opus-5-5', claude: { id: 'login-first', email: 'first@example.com', plan: 'max', savedAt: AT } }),
      makeConnection('anthropic', { id: 'claude-second', model: 'claude-opus-5-5', claude: { id: 'login-other', email: 'second@example.com', plan: 'max', savedAt: AT } }),
      makeConnection('openrouter', { apiKey: 'snapshot-api-secret', model: 'anthropic/claude-opus-5.5' }),
      makeConnection('codex', {
        model: 'gpt-5.4',
        codex: { method: 'code', accountId: 'snapshot-account', email: 'codex@example.com', plan: 'plus', accessToken: 'snapshot-access-secret', refreshToken: 'snapshot-refresh-secret', expiresAt: 1, savedAt: AT },
      }),
    ],
    fallbacks: [{ connection: 'claude-second', model: 'claude-opus-5-5' }],
  };
});

afterEach(() => {
  mock.restore();
  setBearerSessions(null);
  forgetServed();
  forgetUsage();
  if (previousAgents === undefined) delete process.env.METRO_AGENTS_DIR;
  else process.env.METRO_AGENTS_DIR = previousAgents;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function onDisk(raw: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'metro-model-snapshot-'));
  dirs.push(dir);
  process.env.METRO_AGENTS_DIR = dir;
  const path = join(dir, 'model.json');
  writeFileSync(path, raw);
  return { dir, path };
}

interface Answer {
  status: number;
  headers: OutgoingHttpHeaders;
  body: unknown;
}

function request(method = 'GET', authorization = AUTH, path = SNAPSHOT, deps: ModelApiDeps = { read }): Promise<Answer> {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.url = path;
  req.headers = { authorization, origin: 'https://metro.box' };
  const res = new ServerResponse(req);
  return new Promise((resolve) => {
    spyOn(res, 'end').mockImplementation((body?: unknown) => {
      resolve({ status: res.statusCode, headers: res.getHeaders(), body: typeof body === 'string' ? JSON.parse(body) as unknown : null });
      return res;
    });
    if (!handleModelRequest(req, res, { write, claudeUsage, fetchImpl: globalThis.fetch, ...deps })) res.writeHead(404).end();
  });
}

function expectReadOnly(): void {
  expect(ids.newId).not.toHaveBeenCalled();
  expect(secureFs.writeSecure).not.toHaveBeenCalled();
  expect(usageRefresh.refreshUsage).not.toHaveBeenCalled();
  expect(claudeUsage).not.toHaveBeenCalled();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
}

test('snapshot returns only sanitized settings with previously recorded usage and the exact last-served connection', async () => {
  const first = { windows: [{ label: '5-hour window', used: 0.42, resetAt: null, detail: null }], note: null, at: AT };
  const second = { ...first, windows: [{ label: '5-hour window', used: 0.73, resetAt: null, detail: null }] };
  noteUsage('claude-first', first);
  noteUsage('claude-second', second);
  tallyTokens('claude-second', { input: 120, output: 30, cached: 80 }, new Date(AT));
  const served = { connection: 'claude-second', provider: 'anthropic', model: 'claude-opus-5-5', at: AT };
  noteServed(served);
  const before = structuredClone(stored);
  const expected = settingsBody(stored);

  const answer = await request();

  expect(answer.status).toBe(200);
  expect(answer.headers['cache-control']).toBe('no-store');
  expect(answer.headers['content-type']).toBe('application/json');
  expect(answer.body).toEqual(expected);
  expect(answer.body).toMatchObject({
    route: 'claude-first',
    lastServed: served,
    usage: {
      'claude-first': { ...first, tally: null },
      'claude-second': { ...second, tally: { requests: 1, input: 120, output: 30, cached: 80, since: AT } },
    },
    chain: [
      { connection: 'claude-first', model: 'claude-opus-5-5', used: 0.42, hold: null, active: true },
      { connection: 'claude-second', model: 'claude-opus-5-5', used: 0.73, hold: null, active: false },
    ],
  });
  for (const secret of ['snapshot-api-secret', 'snapshot-access-secret', 'snapshot-refresh-secret', 'login-first', 'login-other', 'apiKey', 'accessToken', 'refreshToken', 'savedAt']) {
    expect(JSON.stringify(answer.body)).not.toContain(secret);
  }
  expect(answer.body).not.toHaveProperty('version');
  expect(read).toHaveBeenCalledTimes(1);
  expect(stored).toEqual(before);
  expectReadOnly();
});

test('snapshot with no recorded usage does not start a provider or login probe', async () => {
  stored = { version: 2, route: '', connections: [] };
  const answer = await request('GET', AUTH, `${SNAPSHOT}?refresh=true`);
  expect(answer.status).toBe(200);
  expect(answer.body).toEqual(settingsBody(stored));
  expect(answer.body).toMatchObject({ usage: {}, lastServed: null });
  expect(read).toHaveBeenCalledTimes(1);
  expectReadOnly();
});

test('snapshot refuses missing or invalid bearer sessions before reading settings', async () => {
  for (const authorization of ['', 'Bearer invalid', 'Basic snapshot-member']) {
    const answer = await request('GET', authorization);
    expect(answer.status).toBe(401);
    expect(answer.body).toEqual({ error: 'unauthorized' });
  }
  expect(read).not.toHaveBeenCalled();
  expectReadOnly();
});

test.each(['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])('snapshot refuses %s without reading or changing settings', async (method) => {
  const answer = await request(method);
  expect(answer.status).toBe(405);
  expect(answer.body).toEqual({ error: 'method not allowed' });
  expect(read).not.toHaveBeenCalled();
  expectReadOnly();
});

test('snapshot keeps the existing unauthenticated CORS preflight', async () => {
  const answer = await request('OPTIONS', '');
  expect(answer.status).toBe(204);
  expect(answer.headers['access-control-allow-origin']).toBe('https://metro.box');
  expect(answer.body).toBeNull();
  expect(read).not.toHaveBeenCalled();
  expectReadOnly();
});

test('snapshot matches only its exact path', async () => {
  for (const path of [`${SNAPSHOT}/bundle`, `${SNAPSHOT}-extra`]) expect((await request('GET', AUTH, path)).status).toBe(404);
  expect(read).not.toHaveBeenCalled();
  expectReadOnly();
});

test.each([undefined, '', '  ', null, 123])('snapshot refuses an on-disk connection id of %p without generating ids or repairing the file', async (id) => {
  const raw = `${JSON.stringify({ version: 2, route: '', connections: [{ id, provider: 'anthropic', apiKey: 'legacy-secret', model: 'claude-opus-5-5' }] }, null, 4)}\n`;
  const { dir, path } = onDisk(raw);
  const before = statSync(path);

  const answer = await request('GET', AUTH, SNAPSHOT, {});

  expect(answer.status).toBe(400);
  expect(answer.body).toEqual({ error: 'model snapshot is unavailable until every connection has a saved id' });
  expect(readFileSync(path, 'utf8')).toBe(raw);
  expect(statSync(path)).toMatchObject({ ino: before.ino, mode: before.mode, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs });
  expect(readdirSync(dir)).toEqual(['model.json']);
  expect(read).not.toHaveBeenCalled();
  expectReadOnly();
});

test('snapshot reads valid disk settings and exact cached readings without rewriting them', async () => {
  const raw = `${JSON.stringify(stored, null, 4)}\n`;
  const { dir, path } = onDisk(raw);
  const before = statSync(path);
  const usage = { windows: [{ label: '5-hour window', used: 0.73, resetAt: null, detail: null }], note: null, at: AT };
  noteUsage('claude-second', usage);
  const served = { connection: 'claude-second', provider: 'anthropic', model: 'claude-opus-5-5', at: AT };
  noteServed(served);
  const expected = settingsBody(stored);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const answer = await request('GET', AUTH, SNAPSHOT, {});
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual(expected);
    expect(answer.body).toMatchObject({ route: 'claude-first', usage: { 'claude-second': { ...usage, tally: null } }, lastServed: served });
    for (const secret of ['snapshot-api-secret', 'snapshot-access-secret', 'snapshot-refresh-secret', 'login-first', 'login-other']) {
      expect(JSON.stringify(answer.body)).not.toContain(secret);
    }
  }
  expect(readFileSync(path, 'utf8')).toBe(raw);
  expect(statSync(path)).toMatchObject({ ino: before.ino, mode: before.mode, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs });
  expect(readdirSync(dir)).toEqual(['model.json']);
  expect(read).not.toHaveBeenCalled();
  expectReadOnly();
});

test('the existing settings GET still refreshes usage', async () => {
  const refresh = spyOn(usageRefresh, 'refreshUsage').mockResolvedValue(undefined);
  const answer = await request('GET', AUTH, '/api/model');
  expect(answer.status).toBe(200);
  expect(answer.body).toEqual(settingsBody(stored));
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(claudeUsage).not.toHaveBeenCalled();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});
