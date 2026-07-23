import { describe, expect, test } from 'bun:test';
import { lineOf, targetOf } from '../src/accounts.js';

const uid = `U${'a'.repeat(32)}`;
const gid = `C${'b'.repeat(32)}`;

describe('line scheme', () => {
  test('lineOf builds metro://line/<account>/<sourceId>', () => {
    expect(lineOf('l0', uid)).toBe(`metro://line/l0/${uid}`);
  });

  test('targetOf parses an account-scoped line', () => {
    expect(targetOf(`metro://line/l0/${gid}`)).toEqual({
      accountId: 'l0',
      sourceId: gid,
    });
  });

  test('targetOf defaults the account when only a source id is present', () => {
    expect(targetOf(`metro://line/${uid}`)).toEqual({
      accountId: 'default',
      sourceId: uid,
    });
  });

  test('targetOf rejects a non-line line', () => {
    expect(targetOf(`metro://telegram/l0/${uid}`)).toBeUndefined();
  });

  test('targetOf rejects a malformed source id', () => {
    expect(targetOf('metro://line/l0/not-a-mid')).toBeUndefined();
  });
});
