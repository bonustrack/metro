import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { IncomingMessage, ServerResponse, type OutgoingHttpHeaders } from 'node:http';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ids from '@metro-labs/core/ids';
import * as secureFs from '@metro-labs/core/secure-fs';
import { setBearerSessions } from '@metro-labs/http/api-http';
import { handleModelRequest, settingsBody, type ModelApiDeps } from '../src/gateway/model-api.js';
import type { ModelSetup } from '../src/gateway/model-config.js';
import { forgetServed, noteServed } from '../src/gateway/served.js';
import { forgetUsage, noteUsage, tallyTokens } from '../src/gateway/usage.js';
import * as usageRefresh from '../src/gateway/usage-refresh.js';
import { codexAccess, makeConnection } from './model-fixture.js';

const SNAPSHOT = '/api/model/snapshot';
const AUTH = 'Bearer snapshot-member';
const AT = '2026-01-01T00:00:00.000Z';
const LOGINS = [
  { id: 'loginFirst1', email: 'first@example.com', plan: 'max', savedAt: AT },
  { id: 'loginOther1', email: 'second@example.com', plan: 'max', savedAt: AT },
];
let dir = '';
let stored: ModelSetup;
const setup = mock((): ModelSetup => stored);
const sync = mock((): Promise<void> => Promise.reject(new Error('unexpected sync')));
const claudeUsage = mock((): Promise<unknown> => Promise.reject(new Error('unexpected Claude usage probe')));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-model-snapshot-'));
  writeFileSync(join(dir, 'model.json'), `${JSON.stringify({ version: 3, claude: LOGINS }, null, 4)}\n`);
  spyOn(ids, 'newId');
  spyOn(secureFs, 'writeSecure');
  forgetServed();
  forgetUsage();
  setup.mockClear();
  sync.mockClear();
  claudeUsage.mockClear();
  setBearerSessions((req) => Promise.resolve(req.headers.authorization === AUTH ? { subject: 'snapshot-owner', role: 'member' } : null));
  spyOn(usageRefresh, 'refreshUsage').mockRejectedValue(new Error('unexpected usage refresh'));
  spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network request'));
  stored = {
    primary: { connection: 'local:loginFirst1', model: 'claude-opus-5-5' },
    fallbacks: [{ connection: 'local:loginOther1', model: 'claude-opus-5-5' }],
    connections: [
      makeConnection('anthropic', { id: 'local:loginFirst1', claude: 'loginFirst1', account: { email: 'first@example.com', plan: 'max', method: null } }),
      makeConnection('anthropic', { id: 'local:loginOther1', claude: 'loginOther1', account: { email: 'second@example.com', plan: 'max', method: null } }),
      makeConnection('openrouter', { apiKey: 'snapshot-api-secret', model: 'anthropic/claude-opus-5.5' }),
      makeConnection('codex', { model: 'gpt-5.4', codex: codexAccess({ method: 'code', accountId: 'snapshot-account', accessToken: 'snapshot-access-secret' }) }),
    ],
    source: 'organization',
  };
});

afterEach(() => {
  mock.restore();
  setBearerSessions(null);
  forgetServed();
  forgetUsage();
  rmSync(dir, { recursive: true, force: true });
});

interface Answer {
  status: number;
  headers: OutgoingHttpHeaders;
  body: unknown;
}

const deps = (): ModelApiDeps => ({ setup, sync, dir: () => dir, claudeUsage, fetchImpl: globalThis.fetch });

function request(method = 'GET', authorization = AUTH, path = SNAPSHOT): Promise<Answer> {
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
    if (!handleModelRequest(req, res, deps())) res.writeHead(404).end();
  });
}

function expectReadOnly(): void {
  expect(ids.newId).not.toHaveBeenCalled();
  expect(secureFs.writeSecure).not.toHaveBeenCalled();
  expect(usageRefresh.refreshUsage).not.toHaveBeenCalled();
  expect(claudeUsage).not.toHaveBeenCalled();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(sync).not.toHaveBeenCalled();
}

test('snapshot returns only sanitized settings with previously recorded usage and the exact last-served connection', async () => {
  const first = { windows: [{ label: '5-hour window', used: 0.42, resetAt: null, detail: null }], note: null, at: AT };
  const second = { ...first, windows: [{ label: '5-hour window', used: 0.73, resetAt: null, detail: null }] };
  noteUsage('local:loginFirst1', first);
  noteUsage('local:loginOther1', second);
  tallyTokens('local:loginOther1', { input: 120, output: 30, cached: 80 }, new Date(AT));
  const served = { connection: 'local:loginOther1', provider: 'anthropic', model: 'claude-opus-5-5', at: AT };
  noteServed(served);
  const before = structuredClone(stored);
  const raw = readFileSync(join(dir, 'model.json'), 'utf8');
  const expected = settingsBody(deps());

  const answer = await request();

  expect(answer.status).toBe(200);
  expect(answer.headers['cache-control']).toBe('no-store');
  expect(answer.headers['content-type']).toBe('application/json');
  expect(answer.body).toEqual(expected);
  expect(answer.body).toMatchObject({
    source: 'organization',
    route: 'local:loginFirst1',
    model: 'claude-opus-5-5',
    lastServed: served,
    claude: LOGINS,
    usage: {
      'local:loginFirst1': { ...first, tally: null },
      'local:loginOther1': { ...second, tally: { requests: 1, input: 120, output: 30, cached: 80, since: AT } },
    },
    chain: [
      { connection: 'local:loginFirst1', model: 'claude-opus-5-5', used: 0.42, hold: null, active: true },
      { connection: 'local:loginOther1', model: 'claude-opus-5-5', used: 0.73, hold: null, active: false },
    ],
  });
  for (const secret of ['snapshot-api-secret', 'snapshot-access-secret', 'snapshot-account', 'apiKey', 'accessToken', 'refreshToken', 'credential']) {
    expect(JSON.stringify(answer.body)).not.toContain(secret);
  }
  expect(stored).toEqual(before);
  expect(readFileSync(join(dir, 'model.json'), 'utf8')).toBe(raw);
  expect(readdirSync(dir)).toEqual(['model.json']);
  expectReadOnly();
});

test('snapshot with no route and no recorded usage starts no provider or login probe', async () => {
  stored = { primary: null, fallbacks: [], connections: [], source: null };
  const answer = await request('GET', AUTH, `${SNAPSHOT}?refresh=true`);
  expect(answer.status).toBe(200);
  expect(answer.body).toEqual(settingsBody(deps()));
  expect(answer.body).toMatchObject({ usage: {}, lastServed: null, route: '', ready: true, reason: null, source: null });
  expectReadOnly();
});

test('snapshot refuses missing or invalid bearer sessions before reading settings', async () => {
  for (const authorization of ['', 'Bearer invalid', 'Basic snapshot-member']) {
    const answer = await request('GET', authorization);
    expect(answer.status).toBe(401);
    expect(answer.body).toEqual({ error: 'unauthorized' });
  }
  expect(setup).not.toHaveBeenCalled();
  expectReadOnly();
});

test.each(['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])('snapshot refuses %s without reading or changing settings', async (method) => {
  const answer = await request(method);
  expect(answer.status).toBe(405);
  expect(answer.body).toEqual({ error: 'method not allowed' });
  expect(setup).not.toHaveBeenCalled();
  expectReadOnly();
});

test('snapshot keeps the existing unauthenticated CORS preflight', async () => {
  const answer = await request('OPTIONS', '');
  expect(answer.status).toBe(204);
  expect(answer.headers['access-control-allow-origin']).toBe('https://metro.box');
  expect(answer.body).toBeNull();
  expect(setup).not.toHaveBeenCalled();
  expectReadOnly();
});

test('snapshot matches only its exact path', async () => {
  for (const path of [`${SNAPSHOT}/bundle`, `${SNAPSHOT}-extra`]) expect((await request('GET', AUTH, path)).status).toBe(404);
  expect(setup).not.toHaveBeenCalled();
  expectReadOnly();
});

test('the settings GET refreshes usage, and the model file is never rewritten', async () => {
  const refresh = spyOn(usageRefresh, 'refreshUsage').mockResolvedValue(undefined);
  const before = statSync(join(dir, 'model.json'));
  const answer = await request('GET', AUTH, '/api/model');
  expect(answer.status).toBe(200);
  expect(answer.body).toEqual(settingsBody(deps()));
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(claudeUsage).not.toHaveBeenCalled();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(statSync(join(dir, 'model.json'))).toMatchObject({ ino: before.ino, mtimeMs: before.mtimeMs });
});
