import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { IncomingMessage, ServerResponse, type OutgoingHttpHeaders } from 'node:http';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setBearerSessions } from '@metro-labs/http/api-http';
import * as secureFs from '@metro-labs/core/secure-fs';
import { handleClaudeRequest } from '../src/claude/api.js';
import { sessionSnapshot, type SessionDeps } from '../src/claude/session.js';
import * as runner from '../src/claude/runner.js';
import * as login from '../src/claude/login.js';
import * as model from '../src/gateway/model-config.js';

const SNAPSHOT = '/api/claude/session/snapshot';
const AUTH = 'Bearer snapshot-member';
let dir = '';
let home = '';
let agents = '';
let calls = '';
let running = '';
let deps: SessionDeps;
const unexpected = (): never => { throw new Error('snapshot must only observe session state'); };
const signedIn = mock(unexpected);
const kill = process.kill.bind(process);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-session-snapshot-'));
  home = join(dir, 'home');
  agents = join(dir, 'agents');
  calls = join(dir, 'calls');
  running = join(dir, 'running');
  mkdirSync(join(home, '.metro'), { recursive: true });
  mkdirSync(agents);
  const tmux = join(dir, 'tmux');
  writeFileSync(tmux, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n[ "$*" = 'has-session -t metro' ] && [ -f '${running}' ]\n`, { mode: 0o700 });
  deps = { tmux, home, agents, signedIn };
  signedIn.mockClear();
  setBearerSessions((req) => Promise.resolve(req.headers.authorization === AUTH ? { subject: 'snapshot-owner', role: 'member' } : null));
  spyOn(runner, 'harnessRunner').mockImplementation(unexpected);
  spyOn(login, 'claudeAccount').mockImplementation(unexpected);
  spyOn(login, 'claudeInstalled').mockImplementation(unexpected);
  spyOn(model, 'readModelConfig').mockImplementation(unexpected);
  spyOn(secureFs, 'writeJson').mockImplementation(unexpected);
  spyOn(globalThis, 'fetch').mockImplementation(unexpected);
  spyOn(process, 'kill').mockImplementation((pid, signal) => {
    expect(signal).toBe(0);
    return kill(pid, signal);
  });
});

afterEach(() => {
  mock.restore();
  setBearerSessions(null);
  rmSync(dir, { recursive: true, force: true });
});

function record(runnerValue?: string): void {
  writeFileSync(join(agents, 'claude-session.json'), JSON.stringify({ version: 'recorded-version', runner: runnerValue }));
}

function activity(over: Record<string, unknown> = {}): void {
  const stat = process.platform === 'linux' ? readFileSync(`/proc/${String(process.pid)}/stat`, 'utf8') : '';
  const procStart = stat === '' ? undefined : stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  writeFileSync(join(home, '.metro', 'agent-status.json'), JSON.stringify({
    runner: 'sdk', pid: process.pid, procStart, updatedAt: Date.now(), phase: 'working', ...over,
  }));
}

function expectPassive(): void {
  expect(signedIn).not.toHaveBeenCalled();
  expect(runner.harnessRunner).not.toHaveBeenCalled();
  expect(login.claudeAccount).not.toHaveBeenCalled();
  expect(login.claudeInstalled).not.toHaveBeenCalled();
  expect(model.readModelConfig).not.toHaveBeenCalled();
  expect(secureFs.writeJson).not.toHaveBeenCalled();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  if (existsSync(calls)) expect(readFileSync(calls, 'utf8').trim().split('\n').every((call) => call === 'has-session -t metro')).toBe(true);
}

interface Answer {
  status: number;
  headers: OutgoingHttpHeaders;
  body: unknown;
}

function request(method = 'GET', authorization = AUTH): Promise<Answer> {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.url = SNAPSHOT;
  req.headers = { authorization, origin: 'https://metro.box' };
  const res = new ServerResponse(req);
  return new Promise((resolve) => {
    spyOn(res, 'end').mockImplementation((body?: unknown) => {
      resolve({ status: res.statusCode, headers: res.getHeaders(), body: typeof body === 'string' ? JSON.parse(body) as unknown : null });
      return res;
    });
    if (!handleClaudeRequest(req, res, { dir: unexpected, session: deps })) res.writeHead(404).end();
  });
}

test('live tmux returns its recorded CLI runner, not the configured SDK preference', async () => {
  record('cli');
  writeFileSync(running, '');
  writeFileSync(join(agents, 'claude-setup.json'), JSON.stringify({ runner: 'sdk' }));
  const before = readFileSync(join(agents, 'claude-session.json'), 'utf8');
  const answer = await request();
  expect(answer.status).toBe(200);
  expect(answer.headers['cache-control']).toBe('no-store');
  expect(answer.body).toMatchObject({ running: true, runner: 'cli', activity: null });
  expect(answer.body).toHaveProperty('lastStartedAt');
  expect(answer.body).not.toHaveProperty('blocked');
  expect(answer.body).not.toHaveProperty('autostart');
  expect(readFileSync(join(agents, 'claude-session.json'), 'utf8')).toBe(before);
  expectPassive();
});

test('a live tmux session with no valid recorded runner stays unknown', () => {
  writeFileSync(running, '');
  for (const preference of ['cli', 'sdk']) {
    writeFileSync(join(agents, 'claude-setup.json'), JSON.stringify({ runner: preference }));
    for (const recorded of [undefined, 'unknown']) {
      record(recorded);
      expect(sessionSnapshot(deps)).toMatchObject({ running: true, runner: null, activity: null });
    }
  }
  rmSync(join(agents, 'claude-session.json'));
  expect(sessionSnapshot(deps)).toMatchObject({ running: true, runner: null });
  expectPassive();
});

test('verified SDK activity takes precedence over tmux and the previous recorded CLI runner', () => {
  record('cli');
  activity();
  expect(sessionSnapshot(deps)).toMatchObject({ running: true, runner: 'sdk', activity: { phase: 'working', pid: process.pid } });
  writeFileSync(running, '');
  expect(sessionSnapshot(deps)).toMatchObject({ running: true, runner: 'sdk' });
  expectPassive();
});

test('stale activity still identifies a live SDK but preserves its old observation time', () => {
  activity({ updatedAt: 1 });
  expect(sessionSnapshot(deps)).toMatchObject({ running: true, runner: 'sdk', activity: { phase: 'working', updatedAt: 1 } });
  expectPassive();
});

test.skipIf(process.platform !== 'linux')('a reused PID does not identify a live SDK', () => {
  activity({ procStart: '0' });
  expect(sessionSnapshot(deps)).toMatchObject({ running: false, runner: null, activity: { phase: 'working' } });
  record('cli');
  writeFileSync(running, '');
  expect(sessionSnapshot(deps)).toMatchObject({ running: true, runner: 'cli' });
  expectPassive();
});

test('a dead SDK or a stopped snapshot cannot claim a live runner from the recorded choice', () => {
  record('sdk');
  for (const phase of ['working', 'stopped']) {
    activity({ pid: 2_147_483_647, phase, updatedAt: 1 });
    expect(sessionSnapshot(deps)).toMatchObject({ running: false, runner: null, activity: { phase, updatedAt: 1 } });
  }
  activity({ procStart: undefined, phase: 'stopped' });
  expect(sessionSnapshot(deps)).toMatchObject({ running: false, runner: null });
  rmSync(join(home, '.metro', 'agent-status.json'));
  for (const recorded of ['cli', 'sdk']) {
    record(recorded);
    expect(sessionSnapshot(deps)).toMatchObject({ running: false, runner: null, activity: null });
  }
  expectPassive();
});

test('live tmux can identify the recorded SDK before an activity file exists', () => {
  record('sdk');
  writeFileSync(running, '');
  expect(sessionSnapshot(deps)).toMatchObject({ running: true, runner: 'sdk', activity: null });
  expectPassive();
});

test('missing or invalid bearer authentication is refused before any session observation', async () => {
  for (const authorization of ['', 'Bearer invalid', 'Basic snapshot-member']) expect((await request('GET', authorization)).status).toBe(401);
  expect(existsSync(calls)).toBe(false);
  expect(process.kill).not.toHaveBeenCalled();
  expectPassive();
});

test('snapshot accepts only GET with the normal CORS preflight, never a lifecycle method', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']) expect((await request(method)).status).toBe(405);
  const preflight = await request('OPTIONS', '');
  expect(preflight.status).toBe(204);
  expect(preflight.headers['access-control-allow-origin']).toBe('https://metro.box');
  expect(existsSync(calls)).toBe(false);
  expect(process.kill).not.toHaveBeenCalled();
  expectPassive();
});
