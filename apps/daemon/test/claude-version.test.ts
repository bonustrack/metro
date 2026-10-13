import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as agentUser from '../src/agent-user/user.js';
import { handleClaudeRequest } from '../src/claude/api.js';
import type { SessionDeps } from '../src/claude/session.js';
import { CLAUDE_CODE_VERSION } from '../src/claude/pinned.js';
import { claudeVersion, pinClaudeCode, updateClaude } from '../src/claude/version.js';
import * as privilege from '../src/metro-user/privilege.js';
import { auth } from './identity-helper.ts';

const OWNER = '0xef8305e140ac520225daf050e2f71d5fbcc543e7';
let dir = '';

const script = (name: string, body: string): string => {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};

const fakeClaude = (): string =>
  script(
    'claude',
    `case "$1" in --version) cat ${dir}/installed; echo " (Claude Code)";; install) echo "$2" > ${dir}/installed; echo "$2" >> ${dir}/installs;; *) exit 1;; esac`,
  );

const fakeTmux = (): string => script('tmux', `case "$1" in has-session) exit 0;; kill-session) touch ${dir}/killed;; esac; exit 0`);

const session = (): SessionDeps => ({ tmux: fakeTmux(), home: join(dir, 'home'), agents: join(dir, 'agents') });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-claude-version-'));
  const ambientHome = join(dir, 'ambient');
  mkdirSync(join(ambientHome, '.metro'), { recursive: true });
  writeFileSync(join(ambientHome, '.metro', 'agent-status.json'), JSON.stringify({
    runner: 'sdk', pid: process.pid, updatedAt: 1, phase: 'working',
  }));
  spyOn(privilege, 'runningAsMetro').mockReturnValue(false);
  spyOn(agentUser, 'claudeHome').mockReturnValue(ambientHome);
  writeFileSync(join(dir, 'installed'), '2.1.296');
});

afterEach(() => {
  mock.restore();
  rmSync(dir, { recursive: true, force: true });
});

describe('the Claude Code version on a box', () => {
  test('the version metro was checked with is the target, and any other installed build is offered the switch', () => {
    const claude = fakeClaude();
    expect(claudeVersion({ claude })).toEqual({ installed: '2.1.296', latest: CLAUDE_CODE_VERSION, newer: true });
    writeFileSync(join(dir, 'installed'), CLAUDE_CODE_VERSION);
    expect(claudeVersion({ claude })).toEqual({ installed: CLAUDE_CODE_VERSION, latest: CLAUDE_CODE_VERSION, newer: false });
  });

  test('a box without Claude Code reports no installed build rather than failing', () => {
    expect(claudeVersion({ claude: join(dir, 'missing') })).toEqual({ installed: null, latest: CLAUDE_CODE_VERSION, newer: false });
  });

  test('an update installs the checked version, never latest, and restarts only the fixture session', () => {
    const result = updateClaude({ claude: fakeClaude(), session: session() });
    expect(result).toEqual({ installed: CLAUDE_CODE_VERSION, latest: CLAUDE_CODE_VERSION, newer: false, restarted: true });
    expect(readFileSync(join(dir, 'installs'), 'utf8').trim()).toBe(CLAUDE_CODE_VERSION);
    expect(existsSync(join(dir, 'killed'))).toBe(true);
  });

  test('an update that changes nothing leaves the session alone', () => {
    writeFileSync(join(dir, 'installed'), CLAUDE_CODE_VERSION);
    expect(updateClaude({ claude: fakeClaude(), session: session() }).restarted).toBe(false);
    expect(existsSync(join(dir, 'killed'))).toBe(false);
  });

  test('the boot pin installs the checked version only when another one is there', () => {
    const claude = fakeClaude();
    pinClaudeCode({ claude });
    expect(readFileSync(join(dir, 'installed'), 'utf8').trim()).toBe(CLAUDE_CODE_VERSION);
    pinClaudeCode({ claude });
    expect(readFileSync(join(dir, 'installs'), 'utf8').trim().split('\n')).toEqual([CLAUDE_CODE_VERSION]);
    pinClaudeCode({ claude: join(dir, 'missing') });
  });

  test('a failed install is an error naming the version', () => {
    const broken = script('claude', 'case "$1" in --version) echo "2.1.296 (Claude Code)";; *) echo offline >&2; exit 1;; esac');
    expect(() => updateClaude({ claude: broken, session: session() })).toThrow(`claude install ${CLAUDE_CODE_VERSION} failed: offline`);
  });
});

describe('the version over the API', () => {
  let server: Server;
  let base = '';

  beforeEach(async () => {
    const claude = fakeClaude();
    server = createServer((req, res) => {
      const ok = handleClaudeRequest(req, res, {
        session: session(),
        version: { claude },
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

  const call = async (method: string): Promise<Response> =>
    fetch(`${base}/api/claude/version`, { method, headers: { authorization: await auth(OWNER) } });

  test('the owner reads the versions and runs the update', async () => {
    expect((await (await call('GET')).json()) as unknown).toEqual({ installed: '2.1.296', latest: CLAUDE_CODE_VERSION, newer: true });
    expect((await (await call('POST')).json()) as unknown).toEqual({ installed: CLAUDE_CODE_VERSION, latest: CLAUDE_CODE_VERSION, newer: false, restarted: true });
  });
});
