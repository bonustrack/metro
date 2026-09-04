import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import {
  SessionError,
  signSession,
  verifySession,
} from '../src/daemon/session.ts';

const SECRET = 'unit-secret';

function legacyNameSession(agents: string[]): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
    'base64url',
  );
  const body = Buffer.from(
    JSON.stringify({ typ: 'session', sub: 'a@b.co', agents, exp: 9_999_999_999 }),
  ).toString('base64url');
  const data = `${header}.${body}`;
  const sig = createHmac('sha256', SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

describe('session token', () => {
  test('round-trips the subject and agent ids', () => {
    const t = signSession({ subject: 'a@b.co', agentIds: ['agent000001', 'agent000002'] }, SECRET);
    expect(verifySession(t, SECRET)).toEqual({ subject: 'a@b.co', agentIds: ['agent000001', 'agent000002'] });
  });

  test('rejects a correctly signed legacy session that scopes by agent NAME', () => {
    const token = legacyNameSession(['tony']);
    expect(() => verifySession(token, SECRET)).toThrow(/malformed session/);
  });

  test('rejects non-integer or non-positive agent ids', () => {
    for (const bad of [['tony'], [1.5], [0], [-2], 'tony']) {
      const t = signSession(
        { subject: 'a@b.co', agentIds: bad as unknown as number[] },
        SECRET,
      );
      expect(() => verifySession(t, SECRET)).toThrow(/malformed session/);
    }
  });

  test('rejects an expired session', () => {
    const t = signSession({ subject: 'a@b.co', agentIds: ['agent000001'] }, SECRET, { ttlSec: -5 });
    expect(() => verifySession(t, SECRET)).toThrow(/expired/);
  });

  test('rejects a wrong secret', () => {
    const t = signSession({ subject: 'a@b.co', agentIds: ['agent000001'] }, SECRET);
    expect(() => verifySession(t, 'other')).toThrow(SessionError);
  });

  test('signing with an empty secret throws', () => {
    expect(() => signSession({ subject: 'a@b.co', agentIds: [] }, '')).toThrow(SessionError);
  });
});
