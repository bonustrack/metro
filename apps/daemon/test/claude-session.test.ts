import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleClaudeRequest } from '../src/claude/api.js';
import { autostartEnabled, ensureSession, sessionBlocked, setAutostart, startSession, stopSession, type SessionDeps } from '../src/claude/session.js';
import { continueArgs } from '../src/claude/session-continuity.js';
import { auth } from './identity-helper.ts';
import { configOf, makeConnection } from './model-fixture.ts';
import { sdkAllowed } from '../src/claude/runner.js';

const OWNER = '0xef8305e140ac520225daf050e2f71d5fbcc543e7';
const KEY = `mk_${'a'.repeat(43)}`;
const WARNING = 'WARNING: Loading development channels\nChannels: server:metro\n1. I am using this for local development';

let dir = '';
let tmux = '';
let calls = '';
let running = '';
let pane = '';
let priorConfigDir: string | undefined;
let priorClaudeDir: string | undefined;

function fakeTmux(): void {
  writeFileSync(
    tmux,
    [
      '#!/bin/sh',
      `echo "$*" >> ${calls}`,
      `case "$1" in`,
      `  -V) echo "tmux 3.4"; exit 0;;`,
      `  has-session) test -f ${running}; exit $?;;`,
      `  new-session) touch ${running}; exit 0;;`,
      `  kill-session) rm -f ${running}; exit 0;;`,
      `  capture-pane) cat ${pane} 2>/dev/null; exit 0;;`,
      `  send-keys) exit 0;;`,
      'esac',
      'exit 1',
      '',
    ].join('\n'),
  );
  chmodSync(tmux, 0o755);
}

function agent(): void {
  mkdirSync(join(dir, 'agents'), { recursive: true });
  writeFileSync(join(dir, 'agents', 'agent.json'), JSON.stringify({ version: 1, id: 'agent000001', key: KEY, stations: [] }));
}

const deps = (over: Partial<SessionDeps> = {}): SessionDeps => ({
  tmux,
  metro: ['true'],
  home: join(dir, 'home'),
  agents: join(dir, 'agents'),
  signedIn: () => true,
  ...over,
});

const recorded = (): string[] => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-claude-session-'));
  tmux = join(dir, 'tmux');
  calls = join(dir, 'calls.log');
  running = join(dir, 'running');
  pane = join(dir, 'pane.txt');
  mkdirSync(join(dir, 'home'));
  mkdirSync(join(dir, 'agents'));
  mkdirSync(join(dir, 'config'));
  priorConfigDir = process.env.CLAUDE_CONFIG_DIR;
  priorClaudeDir = process.env.METRO_CLAUDE_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(dir, 'config');
  process.env.METRO_CLAUDE_DIR = join(dir, 'config');
  fakeTmux();
});

afterEach(() => {
  if (priorConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = priorConfigDir;
  if (priorClaudeDir === undefined) delete process.env.METRO_CLAUDE_DIR;
  else process.env.METRO_CLAUDE_DIR = priorClaudeDir;
  rmSync(dir, { recursive: true, force: true });
});

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('never got there');
}

describe('what stands in the way of a session', () => {
  test('no agent, then no credential, each named; a signed-in box with an agent is clear', () => {
    expect(sessionBlocked(deps())).toBe('no agent on this machine yet');
    agent();
    expect(sessionBlocked(deps({ signedIn: () => false }))).toContain('not signed in');
    expect(sessionBlocked(deps())).toBeNull();
  });

  test('an SDK routed to an Anthropic API key needs no Claude login', () => {
    agent();
    writeFileSync(join(dir, 'agents', 'claude-setup.json'), JSON.stringify({ runner: 'sdk' }));
    writeFileSync(join(dir, 'agents', 'model.json'), JSON.stringify(configOf('anthropic', [makeConnection('anthropic', { apiKey: 'sk-ant-test' })])));
    expect(sessionBlocked(deps({ signedIn: () => false }))).toBeNull();
  });

  test('a Model page routing to a ready provider counts as a credential', () => {
    agent();
    writeFileSync(
      join(dir, 'agents', 'model.json'),
      JSON.stringify({ version: 2, route: 'c1', connections: [{ id: 'c1', provider: 'openrouter', apiKey: 'k', model: 'anthropic/claude' }] }),
    );
    expect(sessionBlocked(deps({ signedIn: () => false }))).toBeNull();
  });
});

describe('starting the session', () => {
  test('trusts the home folder for Claude Code, opens tmux there with metro claude, and confirms the channels dialog', async () => {
    agent();
    writeFileSync(pane, `${WARNING}\n`);
    const status = startSession(deps({ metro: ['metro', 'claude'] }));
    expect(status.running).toBe(true);
    await until(() => recorded().some((c) => c.startsWith('send-keys')));
    expect(recorded().find((c) => c.startsWith('new-session'))).toStartWith(`new-session -d -s metro -c ${join(dir, 'home')} -x 200 -y 50 metro claude --session-id `);
    expect(recorded()).toContain('send-keys -t metro Enter');
    const config = JSON.parse(readFileSync(join(dir, 'config', '.claude.json'), 'utf8')) as { projects: Record<string, { hasTrustDialogAccepted: boolean }> };
    expect(config.projects[realpathSync(join(dir, 'home'))]).toEqual({ hasTrustDialogAccepted: true });
  });

  test('a session an older metro started is restarted once after an update, then left alone', () => {
    agent();
    expect(ensureSession(deps({ version: '0.1.0-beta.105' }))).toBe('started');
    expect(ensureSession(deps({ version: '0.1.0-beta.105' }))).toBe('running');
    expect(ensureSession(deps({ version: '0.1.0-beta.107' }))).toBe('restarted');
    expect(recorded().filter((c) => c.startsWith('kill-session'))).toHaveLength(1);
    expect(recorded().filter((c) => c.startsWith('new-session'))).toHaveLength(2);
    expect(ensureSession(deps({ version: '0.1.0-beta.107' }))).toBe('running');
    setAutostart(false, join(dir, 'agents'));
    setAutostart(true, join(dir, 'agents'));
    expect(ensureSession(deps({ version: '0.1.0-beta.107' }))).toBe('running');
  });

  test('pins a fresh CLI session and never follows a newer unrelated home transcript', () => {
    agent();
    const home = join(dir, 'home');
    startSession(deps({ metro: ['metro', 'claude'] }));
    const id = (JSON.parse(readFileSync(join(dir, 'agents', 'claude-session.json'), 'utf8')) as { cliSessionId: string }).cliSessionId;
    const project = join(dir, 'config', 'projects', realpathSync(home).replace(/[^A-Za-z0-9]/g, '-'));
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${id}.jsonl`), `${JSON.stringify({ type: 'user', cwd: realpathSync(home), message: { role: 'user', content: 'hi' } })}\n`);
    writeFileSync(join(project, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl'), '{}\n');
    expect(continueArgs(home, join(dir, 'config'), join(dir, 'agents'))).toEqual(['--resume', id]);
    expect(continueArgs(home, undefined, join(dir, 'agents'))).toEqual(['--resume', id]);
    stopSession(deps());
    startSession(deps({ metro: ['metro', 'claude'] }));
    expect(recorded().filter((c) => c.startsWith('new-session')).pop()?.endsWith(` metro claude --resume ${id}`)).toBe(true);
    startSession(deps({ metro: ['metro', 'claude'] }));
    expect(recorded().filter((c) => c.startsWith('new-session'))).toHaveLength(2);
  });

  test('ambiguous history gets a new stable pin, and a missing pinned transcript is never replaced by the newest one', () => {
    const home = join(dir, 'home');
    const agents = join(dir, 'agents');
    const config = join(dir, 'config');
    const project = join(config, 'projects', realpathSync(home).replace(/[^A-Za-z0-9]/g, '-'));
    mkdirSync(project, { recursive: true });
    const ids = ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'];
    for (const id of ids) writeFileSync(join(project, `${id}.jsonl`), '{}\n');
    mkdirSync(join(home, '.metro'), { recursive: true });
    writeFileSync(join(home, '.metro', 'agent-session.json'), JSON.stringify({ sessionId: ids[1], unanswered: [] }));
    const args = continueArgs(home, config, agents);
    expect(args[0]).toBe('--session-id');
    expect(ids).not.toContain(args[1]);
    expect(continueArgs(home, config, agents)).toEqual(args);
  });

  test('the SDK and CLI keep independent saved sessions even when the SDK transcript is newer', () => {
    agent();
    const home = join(dir, 'home');
    const agents = join(dir, 'agents');
    writeFileSync(join(agents, 'claude-setup.json'), JSON.stringify({ runner: 'sdk', sdkOnLogin: true }));
    startSession(deps({ runner: ['metro', 'agent'], metro: ['metro', 'claude'] }));
    expect(recorded().filter((c) => c.startsWith('new-session')).pop()?.endsWith(' metro agent')).toBe(true);
    stopSession(deps());
    writeFileSync(join(agents, 'claude-setup.json'), JSON.stringify({ runner: 'cli' }));
    const project = join(dir, 'config', 'projects', realpathSync(home).replace(/[^A-Za-z0-9]/g, '-'));
    mkdirSync(project, { recursive: true });
    const sdk = '3f4edfe1-a2ee-4543-9feb-5a956e26bdc2';
    const cli = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    writeFileSync(join(agents, 'claude-session.json'), JSON.stringify({ cliSessionId: cli }));
    writeFileSync(join(project, `${cli}.jsonl`), '{}\n');
    mkdirSync(join(home, '.metro'), { recursive: true });
    writeFileSync(join(home, '.metro', 'agent-session.json'), JSON.stringify({ sessionId: sdk, unanswered: [] }));
    writeFileSync(join(project, `${sdk}.jsonl`), '{}\n');
    expect(continueArgs(home, join(dir, 'config'), agents)).toEqual(['--resume', cli]);
    startSession(deps({ metro: ['metro', 'claude'] }));
    expect(recorded().filter((c) => c.startsWith('new-session')).pop()?.endsWith(` metro claude --resume ${cli}`)).toBe(true);
  });

  test('an unpermitted SDK route blocks a start without changing the runner or killing its running session', () => {
    agent();
    const agents = join(dir, 'agents');
    const setup = (): Record<string, unknown> => JSON.parse(readFileSync(join(agents, 'claude-setup.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(agents, 'claude-setup.json'), JSON.stringify({ runner: 'sdk' }));
    expect(sdkAllowed(agents)).toBe(false);
    expect(() => startSession(deps())).toThrow('Agent SDK');
    expect(recorded().some((c) => c.startsWith('new-session'))).toBe(false);
    writeFileSync(join(agents, 'model.json'), JSON.stringify(configOf('anthropic', [makeConnection('anthropic', { apiKey: 'sk-ant-test' })])));
    expect(sdkAllowed(agents)).toBe(true);
    startSession(deps({ runner: ['metro', 'agent'] }));
    writeFileSync(join(agents, 'model.json'), JSON.stringify(configOf('codex', [makeConnection('codex', { model: 'gpt-6' })])));
    expect(ensureSession(deps())).toBe('running');
    expect(recorded().some((c) => c.startsWith('kill-session'))).toBe(false);
    stopSession(deps());
    expect(ensureSession(deps())).toBe('blocked');
    expect(setup().runner).toBe('sdk');
  });

  test('ensure starts once, then reports running, and honours the auto-start switch', () => {
    agent();
    expect(ensureSession(deps())).toBe('started');
    expect(ensureSession(deps())).toBe('running');
    expect(stopSession(deps()).running).toBe(false);
    setAutostart(false, join(dir, 'agents'));
    expect(autostartEnabled(join(dir, 'agents'))).toBe(false);
    expect(ensureSession(deps())).toBe('off');
    setAutostart(true, join(dir, 'agents'));
    expect(ensureSession(deps({ signedIn: () => false }))).toBe('blocked');
  });
});

describe('the session over the API', () => {
  let server: Server;
  let base = '';

  beforeEach(async () => {
    server = createServer((req, res) => {
      const ok = handleClaudeRequest(req, res, {
        session: deps(),
      });
      if (!ok) res.writeHead(404).end();
    });
    await new Promise<void>((done) => {
      server.listen(0, '127.0.0.1', done);
    });
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterEach(() => {
    server.close();
  });

  const call = async (method: string, body?: unknown, who = OWNER): Promise<Response> =>
    fetch(`${base}/api/claude/session`, {
      method,
      headers: { authorization: await auth(who), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  test('the owner reads the status, starts, stops and flips auto-start; a start with nothing ready is a 409', async () => {
    const blocked = (await (await call('GET')).json()) as { running: boolean; blocked: string | null; autostart: boolean };
    expect(blocked).toMatchObject({ running: false, blocked: 'no agent on this machine yet', autostart: true });
    expect((await call('POST', { action: 'start' })).status).toBe(409);
    agent();
    const started = (await (await call('POST', { action: 'start' })).json()) as { running: boolean };
    expect(started.running).toBe(true);
    const stopped = (await (await call('POST', { action: 'stop' })).json()) as { running: boolean; autostart: boolean };
    expect(stopped).toMatchObject({ running: false, autostart: false });
    expect(ensureSession(deps())).toBe('off');
    expect(await (await call('POST', { action: 'start' })).json()).toMatchObject({ running: true, autostart: true });
    expect((await call('POST', { action: 'sideways' })).status).toBe(400);
  });
});
