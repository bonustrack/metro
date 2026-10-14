import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleClaudeRequest } from '../src/claude/api.js';
import * as login from '../src/claude/login.js';
import { autostartEnabled, ensureSession, prepareRunnerStore, runnerAlive, sessionBlocked, sessionLive, setAutostart, startSession, stopSession, type SessionDeps } from '../src/claude/session.js';
import { auth } from './identity-helper.ts';
import { configOf, makeConnection } from './model-fixture.ts';

const OWNER = '0xef8305e140ac520225daf050e2f71d5fbcc543e7';
const KEY = `mk_${'a'.repeat(43)}`;

let dir = '';
let tmux = '';
let calls = '';
let running = '';
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

function activity(pid: number): void {
  const stat = process.platform === 'linux' ? readFileSync(`/proc/${String(pid)}/stat`, 'utf8') : '';
  const procStart = stat === '' ? undefined : stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  mkdirSync(join(dir, 'home', '.metro'), { recursive: true });
  writeFileSync(join(dir, 'home', '.metro', 'agent-status.json'), JSON.stringify({ runner: 'sdk', pid, procStart, updatedAt: Date.now(), phase: 'working' }));
}

const recorded = (): string[] => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-claude-session-'));
  tmux = join(dir, 'tmux');
  calls = join(dir, 'calls.log');
  running = join(dir, 'running');
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
  mock.restore();
  if (priorConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = priorConfigDir;
  if (priorClaudeDir === undefined) delete process.env.METRO_CLAUDE_DIR;
  else process.env.METRO_CLAUDE_DIR = priorClaudeDir;
  rmSync(dir, { recursive: true, force: true });
});

describe('what stands in the way of a session', () => {
  test('no agent, then no credential, each named; a signed-in box with an agent is clear', () => {
    expect(sessionBlocked(deps())).toBe('no agent on this machine yet');
    agent();
    expect(sessionBlocked(deps({ signedIn: () => false }))).toContain('not signed in');
    expect(sessionBlocked(deps())).toBeNull();
  });

  test('a route to an Anthropic API key needs no Claude login', () => {
    agent();
    writeFileSync(join(dir, 'agents', 'model.json'), JSON.stringify(configOf('anthropic', [makeConnection('anthropic', { apiKey: 'sk-ant-test' })])));
    expect(sessionBlocked(deps({ signedIn: () => false }))).toBeNull();
  });

  test('a runner store the boot could not prepare holds nothing back: Start and the watcher run metro agent, which prepares it', () => {
    agent();
    spyOn(login, 'claudeInstalled').mockReturnValue(false);
    spyOn(login, 'claudeAccount').mockReturnValue({ signedIn: false, account: null, plan: null });
    const unprepared = deps({ metro: undefined, signedIn: undefined });
    expect(sessionBlocked(unprepared)).toBeNull();
    expect(startSession(unprepared).running).toBe(true);
    expect(recorded().find((c) => c.startsWith('new-session'))).toEndWith(' agent');
  });

  test('with Claude Code in the store, a missing login and a Model page that routes nowhere still block the start', () => {
    agent();
    spyOn(login, 'claudeInstalled').mockReturnValue(true);
    spyOn(login, 'claudeAccount').mockReturnValue({ signedIn: false, account: null, plan: null });
    expect(sessionBlocked(deps({ metro: undefined, signedIn: undefined }))).toContain('not signed in');
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
  test('opens tmux in the home folder with metro agent, whatever runner an older setup or session file names', () => {
    agent();
    writeFileSync(join(dir, 'agents', 'claude-setup.json'), JSON.stringify({ runner: 'cli' }));
    writeFileSync(join(dir, 'agents', 'claude-session.json'), JSON.stringify({ runner: 'cli', cliSessionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }));
    const status = startSession(deps({ metro: ['metro', 'agent'] }));
    expect(status.running).toBe(true);
    expect(status).not.toHaveProperty('runner');
    expect(status).not.toHaveProperty('channels');
    expect(recorded().find((c) => c.startsWith('new-session'))).toBe(`new-session -d -s metro -c ${join(dir, 'home')} -x 200 -y 50 metro agent`);
    expect(recorded().some((c) => c.startsWith('capture-pane') || c.startsWith('send-keys'))).toBe(false);
    expect(existsSync(join(dir, 'config', '.claude.json'))).toBe(false);
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

  test('a box on a Claude login starts with no operator switch, and a model change never stops a running session', () => {
    agent();
    const agents = join(dir, 'agents');
    writeFileSync(join(agents, 'claude-setup.json'), JSON.stringify({ runner: 'sdk', sdkOnLogin: false }));
    expect(sessionBlocked(deps())).toBeNull();
    startSession(deps({ metro: ['metro', 'agent'] }));
    writeFileSync(join(agents, 'model.json'), JSON.stringify(configOf('codex', [makeConnection('codex', { model: 'gpt-6' })])));
    expect(ensureSession(deps())).toBe('running');
    expect(recorded().some((c) => c.startsWith('kill-session'))).toBe(false);
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

describe('whether the runner is up', () => {
  test('only a live runner process counts, not the tmux session that is still preparing its store', () => {
    agent();
    startSession(deps());
    expect(sessionLive(deps())).toBe(true);
    expect(runnerAlive(deps())).toBe(false);
    activity(process.pid);
    expect(runnerAlive(deps())).toBe(true);
    activity(2 ** 22 + 7);
    expect(runnerAlive(deps())).toBe(false);
  });
});

describe('preparing the runner store', () => {
  test('runs metro agent --prepare, names what went wrong when it fails, and forgets the cached install check either way', async () => {
    const forgot = spyOn(login, 'forgetClaudeChecks');
    const prior = process.env.METRO_CLI_BIN;
    const cli = join(dir, 'cli.mjs');
    const seen = join(dir, 'args.json');
    writeFileSync(cli, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(seen)}, JSON.stringify(process.argv.slice(2)));\nif (process.env.FAIL_PREPARE === '1') { process.stderr.write('no network'); process.exit(3); }\n`);
    process.env.METRO_CLI_BIN = cli;
    try {
      await prepareRunnerStore();
      expect(JSON.parse(readFileSync(seen, 'utf8'))).toEqual(['agent', '--prepare']);
      expect(forgot).toHaveBeenCalledTimes(1);
      process.env.FAIL_PREPARE = '1';
      await expect(prepareRunnerStore()).rejects.toThrow('metro agent --prepare failed: no network');
      expect(forgot).toHaveBeenCalledTimes(2);
    } finally {
      delete process.env.FAIL_PREPARE;
      if (prior === undefined) delete process.env.METRO_CLI_BIN;
      else process.env.METRO_CLI_BIN = prior;
    }
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
