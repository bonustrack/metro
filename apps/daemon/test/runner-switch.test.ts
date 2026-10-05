import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError } from '@metro-labs/http/api-error';
import { spawn } from 'node:child_process';
import { handleClaudeRequest } from '../src/claude/api.js';
import { autostartEnabled, ensureSession, type SessionDeps } from '../src/claude/session.js';
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

test('Stop cancels a directly started process by its exact identity, never a reused PID', async () => {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  const exited = new Promise<void>((resolve) => { child.once('exit', () => { resolve(); }); });
  try {
    const stat = readFileSync(`/proc/${String(child.pid)}/stat`, 'utf8');
    const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? '';
    const path = join(home(), '.metro', 'agent-status.json');
    const activity = { runner: 'sdk', pid: child.pid, updatedAt: Date.now() - 60_000, phase: 'working', procStart };
    writeFileSync(path, JSON.stringify({ ...activity, procStart: `${procStart}0` }));
    expect((await post({ action: 'stop' }, 'session')).status).toBe(200);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    writeFileSync(path, JSON.stringify(activity));
    expect((await post({ runner: 'sdk' })).status).toBe(409);
    expect((await post({ action: 'stop' }, 'session')).status).toBe(200);
    await exited;
    expect(child.signalCode).toBe('SIGTERM');
    expect((await post({ runner: 'sdk' })).status).toBe(200);
  } finally {
    child.kill();
    await exited;
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
