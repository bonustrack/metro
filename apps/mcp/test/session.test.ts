import { describe, expect, test } from 'bun:test';
import {
  SessionError,
  signSession,
  signState,
  verifySession,
  verifyState,
} from '../src/daemon/session.ts';

const SECRET = 'unit-secret';

describe('state token', () => {
  test('round-trips return_to and nonce', () => {
    const t = signState({ return_to: 'https://metro.box/', nonce: 'n1' }, SECRET);
    expect(verifyState(t, SECRET)).toEqual({ return_to: 'https://metro.box/', nonce: 'n1' });
  });

  test('rejects a wrong secret', () => {
    const t = signState({ return_to: 'https://metro.box/', nonce: 'n1' }, SECRET);
    expect(() => verifyState(t, 'other')).toThrow(SessionError);
  });

  test('rejects a tampered payload', () => {
    const t = signState({ return_to: 'https://metro.box/', nonce: 'n1' }, SECRET);
    const [h, , s] = t.split('.');
    const forged = Buffer.from(
      JSON.stringify({ typ: 'state', return_to: 'https://evil.com/', nonce: 'n1', exp: 9e9 }),
    )
      .toString('base64url');
    expect(() => verifyState(`${h}.${forged}.${s}`, SECRET)).toThrow(SessionError);
  });

  test('rejects an expired state', () => {
    const t = signState({ return_to: 'https://metro.box/', nonce: 'n1' }, SECRET, {
      ttlSec: -5,
    });
    expect(() => verifyState(t, SECRET)).toThrow(/expired/);
  });

  test('rejects a session token presented as state (typ guard)', () => {
    const s = signSession({ email: 'a@b.co', agents: ['tony'] }, SECRET);
    expect(() => verifyState(s, SECRET)).toThrow(/token type/);
  });
});

describe('session token', () => {
  test('round-trips email and agents', () => {
    const t = signSession({ email: 'a@b.co', agents: ['tony', 'wan'] }, SECRET);
    expect(verifySession(t, SECRET)).toEqual({ email: 'a@b.co', agents: ['tony', 'wan'] });
  });

  test('rejects an expired session', () => {
    const t = signSession({ email: 'a@b.co', agents: ['tony'] }, SECRET, { ttlSec: -5 });
    expect(() => verifySession(t, SECRET)).toThrow(/expired/);
  });

  test('rejects a wrong secret', () => {
    const t = signSession({ email: 'a@b.co', agents: ['tony'] }, SECRET);
    expect(() => verifySession(t, 'other')).toThrow(SessionError);
  });

  test('rejects a state token presented as session (typ guard)', () => {
    const s = signState({ return_to: 'https://metro.box/', nonce: 'n' }, SECRET);
    expect(() => verifySession(s, SECRET)).toThrow(/token type/);
  });

  test('signing with an empty secret throws', () => {
    expect(() => signSession({ email: 'a@b.co', agents: [] }, '')).toThrow(SessionError);
  });
});
