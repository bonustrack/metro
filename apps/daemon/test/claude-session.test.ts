import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError } from '@metro-labs/http/api-error';
import { handleClaudeRequest } from '../src/claude/api.js';
import { autostartEnabled, ensureSession, sessionBlocked, sessionStatus, setAutostart, startSession, stopSession, type SessionDeps } from '../src/claude/session.js';
import { auth } from './identity-helper.ts';

const OWNER = '0xef8305e140ac520225daf050e2f71d5fbcc543e7';
const KEY = `mk_${'a'.repeat(43)}`;
const WARNING = 'WARNING: Loading development channels\nChannels: server:metro\n1. I am using this for local development';

let dir = '';
let tmux = '';
let calls = '';
let running = '';
let pane = '';
let priorConfigDir: string | undefined;

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
  mkdirSync(join(dir, 'agents', 'andy'), { recursive: true });
  writeFileSync(
    join(dir, 'agents', 'andy', 'agent.json'),
    JSON.stringify({ version: 1, id: 'agent000001', name: 'andy', key: KEY, owner: OWNER, stations: [] }),
  );
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
  process.env.CLAUDE_CONFIG_DIR = join(dir, 'config');
  fakeTmux();
});

afterEach(() => {
  if (priorConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = priorConfigDir;
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

  test('a Model page routing to a ready provider counts as a credential', () => {
    agent();
    writeFileSync(
      join(dir, 'agents', 'model.json'),
      JSON.stringify({ version: 1, provider: 'openrouter', bedrock: { region: '', apiKey: '', model: '' }, openrouter: { apiKey: 'k', model: 'anthropic/claude' }, codex: { model: '', auth: null } }),
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
    expect(recorded()).toContain(`new-session -d -s metro -c ${join(dir, 'home')} -x 200 -y 50 metro claude`);
    expect(recorded()).toContain('send-keys -t metro Enter');
    const config = JSON.parse(readFileSync(join(dir, 'config', '.claude.json'), 'utf8')) as { projects: Record<string, { hasTrustDialogAccepted: boolean }> };
    expect(config.projects[realpathSync(join(dir, 'home'))]).toEqual({ hasTrustDialogAccepted: true });
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
        authorize: (subject: string) => {
          if (subject !== OWNER) throw new ApiError('no such project', 404);
        },
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
      headers: { authorization: await auth(method, '/api/claude/session', who), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  test('the owner reads the status, starts, stops and flips auto-start; a start with nothing ready is a 409', async () => {
    const blocked = (await (await call('GET')).json()) as { running: boolean; blocked: string | null; autostart: boolean };
    expect(blocked).toMatchObject({ running: false, blocked: 'no agent on this machine yet', autostart: true });
    expect((await call('POST', { action: 'start' })).status).toBe(409);
    agent();
    const started = (await (await call('POST', { action: 'start' })).json()) as { running: boolean };
    expect(started.running).toBe(true);
    const stopped = (await (await call('POST', { action: 'stop', autostart: false })).json()) as { running: boolean; autostart: boolean };
    expect(stopped).toMatchObject({ running: false, autostart: false });
    expect((await call('POST', { action: 'sideways' })).status).toBe(400);
    expect((await call('GET', undefined, '0x70997970c51812dc3a010c7d01b50e0d17dc79c8')).status).toBe(404);
  });
});
