import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleClaudeRequest } from '../src/claude/api.js';
import { claudeVersion, forgetClaudeVersion, newerThan, updateClaude } from '../src/claude/version.js';
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
    `case "$1" in --version) cat ${dir}/installed; echo " (Claude Code)";; install) echo 2.1.274 > ${dir}/installed;; *) exit 1;; esac`,
  );

const fakeTmux = (): string => script('tmux', `case "$1" in has-session) exit 0;; kill-session) touch ${dir}/killed;; esac; exit 0`);

const npm = (version: string): typeof fetch => (() => Promise.resolve(new Response(JSON.stringify({ version }), { status: 200 }))) as unknown as typeof fetch;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-claude-version-'));
  writeFileSync(join(dir, 'installed'), '2.1.272');
  forgetClaudeVersion();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the Claude Code version on a box', () => {
  test('orders releases numerically', () => {
    expect(newerThan('2.1.274', '2.1.272')).toBe(true);
    expect(newerThan('2.2.0', '2.1.999')).toBe(true);
    expect(newerThan('2.1.272', '2.1.272')).toBe(false);
    expect(newerThan('2.1.9', '2.1.10')).toBe(false);
  });

  test('reads the installed build from the binary and the latest from npm, and says when the box is behind', async () => {
    const claude = fakeClaude();
    expect(await claudeVersion({ claude, fetchImpl: npm('2.1.274') })).toEqual({ installed: '2.1.272', latest: '2.1.274', newer: true });
    forgetClaudeVersion();
    expect(await claudeVersion({ claude, fetchImpl: npm('2.1.272') })).toEqual({ installed: '2.1.272', latest: '2.1.272', newer: false });
  });

  test('a box without Claude Code or without npm reports nulls rather than failing', async () => {
    const down = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    expect(await claudeVersion({ claude: join(dir, 'missing'), fetchImpl: down })).toEqual({ installed: null, latest: null, newer: false });
  });

  test('an update runs claude install latest, re-reads the build, and restarts a running session so it loads the new one', async () => {
    const claude = fakeClaude();
    const tmux = fakeTmux();
    const result = await updateClaude({ claude, fetchImpl: npm('2.1.274'), session: { tmux } });
    expect(result).toEqual({ installed: '2.1.274', latest: '2.1.274', newer: false, restarted: true });
    expect(existsSync(join(dir, 'killed'))).toBe(true);
    expect(readFileSync(join(dir, 'installed'), 'utf8').trim()).toBe('2.1.274');
  });

  test('an update that changes nothing leaves the session alone', async () => {
    writeFileSync(join(dir, 'installed'), '2.1.274');
    const result = await updateClaude({ claude: fakeClaude(), fetchImpl: npm('2.1.274'), session: { tmux: fakeTmux() } });
    expect(result.restarted).toBe(false);
    expect(existsSync(join(dir, 'killed'))).toBe(false);
  });
});

describe('the version over the API', () => {
  let server: Server;
  let base = '';

  beforeEach(async () => {
    const claude = fakeClaude();
    server = createServer((req, res) => {
      const ok = handleClaudeRequest(req, res, {
        session: { tmux: fakeTmux() },
        version: { claude, fetchImpl: npm('2.1.274') },
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
    fetch(`${base}/api/claude/version`, { method, headers: { authorization: await auth(method, '/api/claude/version', OWNER) } });

  test('the owner reads the versions and runs the update', async () => {
    expect((await (await call('GET')).json()) as unknown).toEqual({ installed: '2.1.272', latest: '2.1.274', newer: true });
    expect((await (await call('POST')).json()) as unknown).toEqual({ installed: '2.1.274', latest: '2.1.274', newer: false, restarted: true });
  });
});
