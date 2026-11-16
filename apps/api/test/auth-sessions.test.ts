import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createSession, liveSession, pruneSessions, revokeSession, ROTATION_GRACE_MS, rotateSession, SESSION_IDLE_MS, SESSION_MAX_MS, type Rotation } from '../src/db/auth-sessions.ts';
import { createLoginLink, redeemLoginLink, revokeLoginLink } from '../src/db/login-links.ts';
import { authSessions, loginLinks, users } from '../src/db/schema.ts';
import { PGLITE_START_MS, PGLITE_STEP_MS, testDb, type TestDb } from './pglite-db.ts';

const NOW = Date.parse('2026-11-16T09:00:00.000Z');
const DAY = 24 * 60 * 60_000;
const ANA = 'user_01ANA';
const OPERATOR = 'user_01OPERATOR';

let held: TestDb;

const tokenOf = (r: Rotation): string => {
  if (r.kind !== 'rotated') throw new Error(`refused: ${r.reason}`);
  return r.refreshToken;
};

beforeAll(async () => {
  held = await testDb();
}, PGLITE_START_MS);

beforeEach(async () => {
  await held.reset();
  await held.db.insert(users).values([{ id: ANA, email: 'ana@example.com', updatedAt: 'x' }, { id: OPERATOR, email: 'admin@stage.box', updatedAt: 'x' }]);
}, PGLITE_STEP_MS);

afterAll(async () => {
  await held.close();
});

describe('auth sessions', () => {
  test('a session stores only the hash of its refresh token, and each rotation gives a new one', async () => {
    const made = await createSession(held.db, { user: ANA, method: 'google', now: NOW });
    expect(made.session).toMatchObject({ user: ANA, method: 'google', createdAt: NOW, expiresAt: NOW + SESSION_IDLE_MS });
    expect(made.session.id).toMatch(/^session_[0-9A-HJKMNP-TV-Z]{26}$/);
    const row = (await held.db.select().from(authSessions))[0];
    expect(row?.refreshHash).toBe(createHash('sha256').update(made.refreshToken).digest('base64url'));
    expect(JSON.stringify(row)).not.toContain(made.refreshToken);
    const next = await rotateSession(held.db, made.refreshToken, NOW + DAY);
    expect(next).toMatchObject({ kind: 'rotated', session: { id: made.session.id, expiresAt: NOW + DAY + SESSION_IDLE_MS } });
    expect(tokenOf(next)).not.toBe(made.refreshToken);
    expect(await rotateSession(held.db, tokenOf(next), NOW + 2 * DAY)).toMatchObject({ kind: 'rotated' });
  });

  test('the previous token works for 60 seconds after a rotation, and after that its reuse revokes the session', async () => {
    const made = await createSession(held.db, { user: ANA, method: 'microsoft', now: NOW });
    const second = tokenOf(await rotateSession(held.db, made.refreshToken, NOW));
    const retried = tokenOf(await rotateSession(held.db, made.refreshToken, NOW + ROTATION_GRACE_MS));
    expect(retried).not.toBe(second);
    const third = tokenOf(await rotateSession(held.db, retried, NOW + ROTATION_GRACE_MS + 1));
    expect(await rotateSession(held.db, retried, NOW + 2 * ROTATION_GRACE_MS + 2)).toEqual({ kind: 'refused', reason: 'reused' });
    expect(await rotateSession(held.db, third, NOW + 2 * ROTATION_GRACE_MS + 3)).toEqual({ kind: 'refused', reason: 'revoked' });
    expect(await liveSession(held.db, made.session.id, NOW + 3 * ROTATION_GRACE_MS)).toBeNull();
  });

  test('a session ends after 30 idle days and after 90 days in all, however often it is used', async () => {
    const idle = await createSession(held.db, { user: ANA, method: 'google', now: NOW });
    expect(await rotateSession(held.db, idle.refreshToken, NOW + SESSION_IDLE_MS)).toEqual({ kind: 'refused', reason: 'expired' });
    const busy = await createSession(held.db, { user: ANA, method: 'link', now: NOW });
    let token = busy.refreshToken;
    for (let day = 20; day < 90; day += 20) token = tokenOf(await rotateSession(held.db, token, NOW + day * DAY));
    const last = await rotateSession(held.db, token, NOW + 85 * DAY);
    expect(last).toMatchObject({ kind: 'rotated', session: { expiresAt: NOW + SESSION_MAX_MS } });
    expect(await rotateSession(held.db, tokenOf(last), NOW + SESSION_MAX_MS)).toEqual({ kind: 'refused', reason: 'expired' });
    expect(await liveSession(held.db, busy.session.id, NOW + SESSION_MAX_MS - 1)).toMatchObject({ id: busy.session.id, user: ANA, method: 'link' });
    expect(await pruneSessions(held.db, NOW + SESSION_MAX_MS)).toBe(2);
    expect(await held.db.select().from(authSessions)).toEqual([]);
  });

  test('a revoked session refuses its token, an unknown token is refused, and revoking twice says so', async () => {
    const made = await createSession(held.db, { user: ANA, method: 'google', now: NOW });
    expect(await revokeSession(held.db, made.session.id, NOW + 1)).toBe(true);
    expect(await revokeSession(held.db, made.session.id, NOW + 2)).toBe(false);
    expect(await rotateSession(held.db, made.refreshToken, NOW + 3)).toEqual({ kind: 'refused', reason: 'revoked' });
    expect(await rotateSession(held.db, 'A'.repeat(43), NOW)).toEqual({ kind: 'refused', reason: 'unknown' });
    expect(await rotateSession(held.db, 'short', NOW)).toEqual({ kind: 'refused', reason: 'unknown' });
  });
});

describe('login links', () => {
  test('a link logs its person in again and again until it is revoked, and only its hash is kept', async () => {
    const link = await createLoginLink(held.db, { user: ANA, by: OPERATOR, now: NOW });
    expect(link.id).toMatch(/^link_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(JSON.stringify(await held.db.select().from(loginLinks))).not.toContain(link.code);
    expect(await redeemLoginLink(held.db, link.code, NOW + 1)).toEqual({ id: link.id, user: ANA });
    expect(await redeemLoginLink(held.db, link.code, NOW + DAY)).toEqual({ id: link.id, user: ANA });
    expect((await held.db.select().from(loginLinks))[0]).toMatchObject({ lastUsedAt: NOW + DAY, createdBy: OPERATOR, revokedAt: null });
    expect(await revokeLoginLink(held.db, link.id, NOW + 2 * DAY)).toBe(true);
    expect(await revokeLoginLink(held.db, link.id, NOW + 2 * DAY)).toBe(false);
    expect(await redeemLoginLink(held.db, link.code, NOW + 3 * DAY)).toBeNull();
  });

  test('a new link replaces the person\'s earlier one, and a bad code or an unknown person is refused', async () => {
    const first = await createLoginLink(held.db, { user: ANA, by: OPERATOR, now: NOW });
    const second = await createLoginLink(held.db, { user: ANA, by: OPERATOR, now: NOW + 1 });
    expect(await redeemLoginLink(held.db, first.code, NOW + 2)).toBeNull();
    expect(await redeemLoginLink(held.db, second.code, NOW + 2)).toEqual({ id: second.id, user: ANA });
    expect(await redeemLoginLink(held.db, 'not a code', NOW)).toBeNull();
    await expect(createLoginLink(held.db, { user: 'user_01NOBODY', by: OPERATOR, now: NOW })).rejects.toMatchObject({ status: 404 });
  });
});
