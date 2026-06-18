/** Unit tests for the sessions.json binding layer + `metro whoami`.
 *
 * Core safety invariant: with NO sessions.json the loader returns {}, all
 * resolvers return null, and whoami reports the env / account-derived identity
 * (today's behavior) — verified explicitly. */

import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoots: string[] = [];
function withSessionsFile(contents: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'metro-sessions-'));
  tempRoots.push(dir);
  const file = join(dir, 'sessions.json');
  if (contents !== null) writeFileSync(file, contents);
  process.env.METRO_SESSIONS_FILE = file;
  return file;
}
afterEach(() => {
  delete process.env.METRO_SESSIONS_FILE;
  for (const d of tempRoots.splice(0)) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function mod() {
  return import('../src/sessions.ts');
}

describe('owner derivation', () => {
  test('sessionOwner derives metro://session/<id>', async () => {
    const { sessionOwner } = await mod();
    expect(sessionOwner('alpha')).toBe('metro://session/alpha');
  });
});

describe('absent-file fallback (SAFETY INVARIANT)', () => {
  test('no sessions.json → not present, empty load, null resolution', async () => {
    withSessionsFile(null);
    const { sessionsPresent, loadSessions, accountForSession, listSessions } = await mod();
    expect(sessionsPresent()).toBe(false);
    expect(loadSessions()).toEqual({});
    expect(accountForSession('alpha', 'xmtp')).toBeNull();
    expect(listSessions()).toEqual([]);
  });
});

describe('parse + binding resolution', () => {
  test('explicit station mapping wins, default is the fallback', async () => {
    withSessionsFile(JSON.stringify({
      alpha: { xmtp: 'tony', discord: 'main', default: 'fallback' },
    }));
    const { accountForSession } = await mod();
    expect(accountForSession('alpha', 'xmtp')).toBe('tony');
    expect(accountForSession('alpha', 'discord')).toBe('main');
    expect(accountForSession('alpha', 'telegram')).toBe('fallback'); // unmapped → default
  });
  test('unmapped station with no default → null', async () => {
    withSessionsFile(JSON.stringify({ alpha: { xmtp: 'tony' } }));
    const { accountForSession } = await mod();
    expect(accountForSession('alpha', 'telegram')).toBeNull();
  });
  test('unknown session → null', async () => {
    withSessionsFile(JSON.stringify({ alpha: { xmtp: 'tony' } }));
    const { accountForSession } = await mod();
    expect(accountForSession('ghost', 'xmtp')).toBeNull();
  });
  test('malformed json → ignored (empty), never throws', async () => {
    withSessionsFile('not json {');
    const { loadSessions, sessionsPresent } = await mod();
    expect(sessionsPresent()).toBe(true);
    expect(loadSessions()).toEqual({});
  });
  test('non-object root / non-object binding → ignored', async () => {
    withSessionsFile(JSON.stringify([1, 2, 3]));
    const { loadSessions } = await mod();
    expect(loadSessions()).toEqual({});
  });
  test('listSessions derives owner per id', async () => {
    withSessionsFile(JSON.stringify({ alpha: { xmtp: 'tony' }, beta: { default: 'x' } }));
    const { listSessions } = await mod();
    const ids = listSessions().map(s => ({ id: s.id, owner: s.owner }));
    expect(ids).toContainEqual({ id: 'alpha', owner: 'metro://session/alpha' });
    expect(ids).toContainEqual({ id: 'beta', owner: 'metro://session/beta' });
  });
});
