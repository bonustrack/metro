import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError } from '@metro-labs/http/api-error';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import { handleClaudeRequest } from '../src/claude/api.js';
import { autostartEnabled, ensureSession, startSession, stopSession, type SessionDeps } from '../src/claude/session.js';
import { harnessRunner, type HarnessRunner } from '../src/claude/runner.js';
import { setSystemPrompt, systemPrompt } from '../src/claude/setup.js';
import { auth } from './identity-helper.ts';
import { configOf, makeConnection } from './model-fixture.ts';

let dir = '';
let server: Server;
let base = '';
let priorConfig: string | undefined;
let session: SessionDeps;
let request: IncomingMessage;
let prepares: HarnessRunner[];
let prepare: (runner: HarnessRunner) => Promise<void>;
const tmuxFixtures = new Set<string>();
const agents = (): string => join(dir, 'agents');
const home = (): string => join(dir, 'home');
const settings = (): Record<string, unknown> => JSON.parse(readFileSync(join(agents(), 'claude-setup.json'), 'utf8')) as Record<string, unknown>;
const commands = (): string => existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8') : '';
const ledger = (text: string): void => { writeFileSync(join(home(), '.metro', 'agent-session.json'), text); };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metro-runner-switch-'));
  mkdirSync(agents());
  mkdirSync(join(home(), '.metro'), { recursive: true });
  mkdirSync(join(dir, 'claude'));
  priorConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude');
  writeFileSync(join(agents(), 'agent.json'), JSON.stringify({ version: 1, id: 'agent000001', key: `mk_${'a'.repeat(43)}`, stations: [] }));
  writeFileSync(join(agents(), 'claude-setup.json'), JSON.stringify({ runner: 'cli', permissionMode: 'auto', privacy: true }));
  setSystemPrompt('Keep this prompt.', agents());
  writeFileSync(join(agents(), 'model.json'), JSON.stringify(configOf('anthropic', [makeConnection('anthropic', { apiKey: 'test-key' })])));
  const tmux = join(dir, 'tmux');
  tmuxFixtures.add(tmux);
  writeFileSync(tmux, `#!/bin/sh\necho "$*" >> '${join(dir, 'calls')}'\ncase "$1" in\n-V) exit 0;;\nhas-session) test -f '${join(dir, 'running')}';;\nnew-session) touch '${join(dir, 'running')}';;\nkill-session) rm -f '${join(dir, 'running')}';;\n*) exit 1;;\nesac\n`);
  chmodSync(tmux, 0o755);
  prepares = [];
  prepare = () => Promise.resolve();
  session = { agents: agents(), home: home(), tmux, metro: ['metro', 'claude'], runner: ['metro', 'agent'], signedIn: () => true, prepare: async (runner) => { prepares.push(runner); await prepare(runner); } };
  server = createServer((req, res) => {
    request = req;
    if (!handleClaudeRequest(req, res, { session, setup: { agents: agents(), dir: join(dir, 'claude'), plugin: join(import.meta.dir, '../../../plugin') } })) res.writeHead(404).end();
  });
  const port = 10_000 + Math.floor(Math.random() * 20_000);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${String(port)}`;
});

afterEach(() => {
  server.closeAllConnections();
  server.close();
  if (priorConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = priorConfig;
  rmSync(dir, { recursive: true, force: true });
});

const post = async (body: unknown, path = 'setup'): Promise<Response> => fetch(`${base}/api/claude/${path}`, {
  method: 'POST', headers: { authorization: await auth('org_01TESTOWNER000000'), 'content-type': 'application/json' }, body: JSON.stringify(body),
});

function held(): { entered: Promise<void>; release: () => void } {
  let enter = (): void => undefined;
  let release = (): void => undefined;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const ready = new Promise<void>((resolve) => { release = resolve; });
  prepare = async () => { enter(); await ready; };
  return { entered, release };
}

test('runner choice never kills a live session; Stop, choose, Start preserves both choices and settings', async () => {
  expect((await post({ action: 'start' }, 'session')).status).toBe(200);
  expect((await post({ runner: 'sdk', privacy: false })).status).toBe(409);
  expect(settings()).toMatchObject({ runner: 'cli', privacy: true });
  expect(prepares).toEqual([]);
  expect(commands()).not.toContain('kill-session');
  for (const runner of ['sdk', 'cli', 'sdk'] as const) {
    expect((await post({ action: 'stop' }, 'session')).status).toBe(200);
    expect((await post({ runner })).status).toBe(200);
    expect(settings()).toMatchObject({ runner, permissionMode: 'auto' });
    expect(systemPrompt(agents())).toBe('Keep this prompt.');
    expect(ensureSession(session)).toBe('off');
    expect((await post({ action: 'start' }, 'session')).status).toBe(200);
  }
  expect(prepares).toEqual(['sdk', 'cli', 'sdk']);
  expect(commands().match(/kill-session/g)).toHaveLength(3);
  expect(commands().match(/new-session/g)).toHaveLength(4);
});

test('failed preparation changes no runner or settings and allows a retry', async () => {
  const before = settings();
  prepare = () => Promise.reject(new ApiError('Bun is unavailable', 503));
  expect((await post({ runner: 'sdk', privacy: false, permissionMode: 'bypass' })).status).toBe(503);
  expect(settings()).toEqual(before);
  expect(commands()).not.toContain('kill-session');
  prepare = () => Promise.resolve();
  expect((await post({ runner: 'sdk' })).status).toBe(200);
  expect(harnessRunner(agents())).toBe('sdk');
});

test('pending or unreadable SDK input refuses a transition, and drained input permits it', async () => {
  expect((await post({ runner: 'sdk' })).status).toBe(200);
  for (const saved of ['{"unanswered":[{"text":"not answered"}]}', '{broken', '{"unanswered":true}', '{"sessionId":{}}']) {
    ledger(saved);
    expect((await post({ runner: 'cli' })).status).toBe(409);
    expect(harnessRunner(agents())).toBe('sdk');
  }
  ledger('{"unanswered":[]}');
  chmodSync(join(home(), '.metro', 'agent-session.json'), 0);
  expect((await post({ runner: 'cli' })).status).toBe(409);
  chmodSync(join(home(), '.metro', 'agent-session.json'), 0o600);
  expect((await post({ runner: 'cli' })).status).toBe(200);
  expect(prepares).toEqual(['sdk', 'cli']);
  expect(commands()).not.toContain('kill-session');
});

test('SDK switching validates interrupted recovery state and every input field without treating archived input as pending', async () => {
  expect((await post({ runner: 'sdk' })).status).toBe(200);
  const input = { text: 'review before retrying', at: Date.now(), uuid: '12345678-1234-1234-1234-123456789abc', state: 'started' };
  for (const state of [
    { interrupted: null },
    { interrupted: {} },
    { interrupted: [null] },
    { interrupted: [{ ...input, text: 1 }] },
    { interrupted: [{ ...input, at: 'now' }] },
    { interrupted: [{ ...input, uuid: 'bad' }] },
    { interrupted: [{ ...input, state: 'finished' }] },
    { unanswered: [{ ...input, uuid: 'bad' }], interrupted: [] },
    { unanswered: [{ ...input, state: 'finished' }], interrupted: [] },
  ]) {
    const text = JSON.stringify(state);
    ledger(text);
    expect((await post({ runner: 'cli' })).status).toBe(409);
    expect(harnessRunner(agents())).toBe('sdk');
    expect(readFileSync(join(home(), '.metro', 'agent-session.json'), 'utf8')).toBe(text);
  }
  ledger(JSON.stringify({ unanswered: [], interrupted: [input] }));
  expect((await post({ runner: 'cli' })).status).toBe(200);
  expect(prepares).toEqual(['sdk', 'cli']);
});

test('preparation serializes choices and holds Start and the watcher without killing anything', async () => {
  const gate = held();
  const pending = post({ runner: 'sdk' });
  await gate.entered;
  try {
    expect((await post({ runner: 'sdk' })).status).toBe(409);
    expect((await post({ action: 'start', autostart: false }, 'session')).status).toBe(409);
    expect(autostartEnabled(agents())).toBe(true);
    expect(ensureSession(session)).toBe('blocked');
    expect(harnessRunner(agents())).toBe('cli');
    expect(commands()).not.toContain('new-session');
  } finally {
    gate.release();
  }
  expect((await pending).status).toBe(200);
  expect(ensureSession(session)).toBe('off');
});

test('a session or incompatible model appearing during preparation leaves the choice unchanged', async () => {
  prepare = () => { writeFileSync(join(dir, 'running'), ''); return Promise.resolve(); };
  expect((await post({ runner: 'sdk' })).status).toBe(409);
  expect(harnessRunner(agents())).toBe('cli');
  rmSync(join(dir, 'running'));
  prepare = () => { writeFileSync(join(agents(), 'model.json'), JSON.stringify(configOf('anthropic', [makeConnection('anthropic')]))); return Promise.resolve(); };
  expect((await post({ runner: 'sdk' })).status).toBe(403);
  expect(harnessRunner(agents())).toBe('cli');
  expect(commands()).not.toContain('kill-session');
});

test('a disconnected preparation request does not commit its choice', async () => {
  const gate = held();
  const pending = post({ runner: 'sdk' }).catch(() => null);
  await gate.entered;
  request.socket.destroy();
  gate.release();
  expect(await pending).toBeNull();
  expect(harnessRunner(agents())).toBe('cli');
  expect((await post({ runner: 'sdk' })).status).toBe(200);
});

test('fresh SDK activity with a live process refuses switching and duplicate starts, even without tmux', async () => {
  const path = join(home(), '.metro', 'agent-status.json');
  for (const phase of ['idle', 'working', 'approval', 'error']) {
    writeFileSync(path, JSON.stringify({ runner: 'sdk', pid: process.pid, updatedAt: Date.now(), phase }));
    expect((await post({ runner: 'sdk' })).status).toBe(409);
    expect(await (await post({ action: 'start' }, 'session')).json()).toMatchObject({ running: true, runner: 'sdk' });
  }
  expect(prepares).toEqual([]);
  expect(commands()).not.toContain('new-session');
  writeFileSync(path, JSON.stringify({ runner: 'sdk', pid: process.pid, updatedAt: Date.now() - 60_000, phase: 'working' }));
  expect(ensureSession(session)).toBe('running');
  expect((await post({ runner: 'sdk' })).status).toBe(409);
  expect(commands()).not.toContain('kill-session');
  rmSync(path);
  expect((await post({ runner: 'sdk' })).status).toBe(200);
});

function fakeRunner(modern = true): { signals: string[][]; fail: boolean } {
  const pid = 123_456_789;
  const processState = { signals: [] as string[][], fail: false };
  const read = fs.readFileSync;
  const spawnSync = childProcess.spawnSync;
  spyOn(fs, 'readFileSync').mockImplementation((path, options) => path === `/proc/${String(pid)}/stat`
    ? `${String(pid)} (sdk) ${['S', ...Array<string>(18).fill('0'), '42'].join(' ')}`
    : read(path, options));
  spyOn(process, 'kill').mockImplementation((target, signal) => {
    expect(target).toBe(pid);
    expect(signal).toBe(0);
    return true;
  });
  spyOn(childProcess, 'spawnSync').mockImplementation((file, args, options) => {
    if (file !== 'kill') {
      expect(tmuxFixtures.has(file)).toBe(true);
      return spawnSync(file, args, options);
    }
    expect(Array.isArray(args)).toBe(true);
    const signalArgs = Array.isArray(args) ? args.map(String) : [];
    expect(signalArgs[1]).toBe(String(pid));
    processState.signals.push(signalArgs);
    return { pid, status: processState.fail ? 1 : 0, signal: null, stdout: '', stderr: 'fixture refused', output: ['', '', ''] };
  });
  writeFileSync(join(home(), '.metro', 'agent-status.json'), JSON.stringify({ runner: 'sdk', pid, updatedAt: Date.now(), phase: 'working', procStart: '42', ...(modern ? { cancelSignal: 'SIGUSR2' } : {}) }));
  return processState;
}

test('Harness Stop cancels only the verified SDK and never races it with tmux shutdown', async () => {
  const fake = fakeRunner();
  try {
    writeFileSync(join(dir, 'running'), '');
    const stopped = await post({ action: 'stop' }, 'session');
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toMatchObject({ running: true, autostart: false });
    expect(fake.signals).toEqual([['-USR2', '123456789']]);
    expect(commands()).not.toContain('kill-session');
    expect(ensureSession(session)).toBe('off');
  } finally {
    mock.restore();
  }
});

test('Harness Stop uses the legacy cancellation signal without the explicit capability', async () => {
  const fake = fakeRunner(false);
  try {
    expect((await post({ action: 'stop' }, 'session')).status).toBe(200);
    expect(fake.signals).toEqual([['-TERM', '123456789']]);
    expect(commands()).not.toContain('kill-session');
  } finally {
    mock.restore();
  }
});

test('a supervisor stop preserves SDK work and lets the verified process close itself', () => {
  const fake = fakeRunner();
  try {
    expect(stopSession(session).running).toBe(true);
    expect(fake.signals).toEqual([['-TERM', '123456789']]);
    expect(commands()).not.toContain('kill-session');
    expect(autostartEnabled(agents())).toBe(true);
  } finally {
    mock.restore();
  }
});

test('a version restart preserves the SDK, then starts its successor after it exits', () => {
  writeFileSync(join(agents(), 'claude-setup.json'), JSON.stringify({ runner: 'sdk' }));
  startSession({ ...session, version: 'old', now: () => 1 });
  const fake = fakeRunner();
  try {
    expect(ensureSession({ ...session, version: 'new', now: () => 60_002 })).toBe('restarted');
    expect(fake.signals).toEqual([['-TERM', '123456789']]);
    expect(commands()).not.toContain('kill-session');
    expect(commands().match(/new-session/g)).toHaveLength(1);
    rmSync(join(dir, 'running'));
    rmSync(join(home(), '.metro', 'agent-status.json'));
    expect(ensureSession({ ...session, version: 'new', now: () => 60_003 })).toBe('started');
    expect(commands().match(/new-session/g)).toHaveLength(2);
  } finally {
    mock.restore();
  }
});

test('Stop never signals a reused SDK PID or an unverifiable live process', async () => {
  const fake = fakeRunner();
  const path = join(home(), '.metro', 'agent-status.json');
  const activity = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  try {
    writeFileSync(path, JSON.stringify({ ...activity, procStart: '43' }));
    expect((await post({ action: 'stop' }, 'session')).status).toBe(200);
    expect(fake.signals).toEqual([]);
    writeFileSync(path, JSON.stringify({ ...activity, procStart: undefined }));
    const refused = await post({ action: 'stop' }, 'session');
    expect(refused.status).toBe(503);
    expect(await refused.text()).toContain('cannot be verified safely');
    expect(fake.signals).toEqual([]);
  } finally {
    mock.restore();
  }
});

test('a failed SDK cancellation is reported without a destructive tmux fallback', async () => {
  const fake = fakeRunner();
  fake.fail = true;
  try {
    writeFileSync(join(dir, 'running'), '');
    const refused = await post({ action: 'stop' }, 'session');
    expect(refused.status).toBe(503);
    expect(await refused.text()).toContain('could not be stopped');
    expect(commands()).not.toContain('kill-session');
  } finally {
    mock.restore();
  }
});

test('permission and prompt changes require Stop, and an unrelated save never silently falls back from SDK', async () => {
  expect((await post({ action: 'start' }, 'session')).status).toBe(200);
  expect((await post({ permissionMode: 'bypass' })).status).toBe(409);
  expect((await post({ systemPrompt: 'New prompt' })).status).toBe(409);
  expect(commands()).not.toContain('kill-session');
  expect((await post({ action: 'stop' }, 'session')).status).toBe(200);
  expect((await post({ runner: 'sdk', permissionMode: 'bypass', systemPrompt: 'New prompt' })).status).toBe(200);
  writeFileSync(join(agents(), 'model.json'), JSON.stringify(configOf('anthropic', [makeConnection('anthropic')])));
  expect((await post({ privacy: false })).status).toBe(200);
  expect(settings()).toMatchObject({ runner: 'sdk', permissionMode: 'bypass', privacy: false });
  expect(systemPrompt(agents())).toBe('New prompt');
});
