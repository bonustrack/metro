/**
 * Unit tests for `src/local-identity.ts` — claude user + session id resolution.
 *
 * Env-only resolvers (METRO_USER_ID / METRO_USER_SESSION_ID short-circuits,
 * CLAUDE_CODE_SESSION_ID fallback) are tested in-process. No `claude` CLI is
 * ever invoked (that would shell out), so we only assert the env short-circuit
 * for claudeUserId.
 */

import { describe, expect, test, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const IDENT_JS = join(ROOT, 'dist', 'daemon', 'identity.js');

const tempRoots: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'metro-ident-'));
  tempRoots.push(d);
  return d;
}
afterAll(() => {
  for (const d of tempRoots) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Run one exported function from dist/local-identity.js in a fresh process. */
function runIdent(fn: string, env: Record<string, string>): { stdout: string; stderr: string; status: number } {
  const driver = `
    import * as m from ${JSON.stringify(IDENT_JS)};
    try { process.stdout.write(String(m[${JSON.stringify(fn)}]())); }
    catch (e) { process.stderr.write(e.message); process.exit(7); }
  `;
  const r = spawnSync('node', ['--input-type=module', '-e', driver], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status ?? 0 };
}

describe('claudeUserId — METRO_USER_ID short-circuit', () => {
  test('claudeUserId returns METRO_USER_ID without invoking claude CLI', () => {
    const r = runIdent('claudeUserId', { METRO_USER_ID: 'org-123', METRO_STATE_DIR: freshDir() });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('org-123');
  });
});

/* ── In-process: env-only session resolver ── */

const SAVED: Record<string, string | undefined> = {};
const ENV_KEYS = ['METRO_USER_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'METRO_USER_ID'];

beforeEach(() => {
  for (const k of ENV_KEYS) { SAVED[k] = process.env[k]; delete process.env[k]; }
});
afterAll(() => {
  for (const k of ENV_KEYS) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]!; }
});

describe('claudeSessionId — env precedence', () => {
  test('METRO_USER_SESSION_ID wins', async () => {
    const { claudeSessionId } = await import('../src/daemon/identity.ts');
    process.env.METRO_USER_SESSION_ID = 'sess-A';
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-B';
    expect(claudeSessionId()).toBe('sess-A');
  });

  test('falls back to CLAUDE_CODE_SESSION_ID', async () => {
    const { claudeSessionId } = await import('../src/daemon/identity.ts');
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-B';
    expect(claudeSessionId()).toBe('sess-B');
  });

  test('null when neither set', async () => {
    const { claudeSessionId } = await import('../src/daemon/identity.ts');
    expect(claudeSessionId()).toBeNull();
  });
});
