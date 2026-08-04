import { describe, expect, test } from 'bun:test';
import {
  needsPassword,
  readableAuthError,
  rpcErrorText,
  TelegramUserLoginError,
  validateCredentials,
} from '../src/login.ts';

const GOOD = {
  apiId: 1234567,
  apiHash: '0123456789abcdef0123456789abcdef',
  phone: '447700900123',
};

const reject = (raw: Record<string, unknown>): TelegramUserLoginError => {
  try {
    validateCredentials(raw as never);
  } catch (err) {
    return err as TelegramUserLoginError;
  }
  throw new Error('should have been refused');
};

describe('validateCredentials', () => {
  test('accepts the values my.telegram.org hands out', () => {
    expect(validateCredentials(GOOD)).toEqual(GOOD);
  });

  test('accepts an api id sent as a string, and a formatted phone', () => {
    expect(
      validateCredentials({
        ...GOOD,
        apiId: '1234567',
        phone: '+44 (770) 090-0123',
      }),
    ).toEqual(GOOD);
  });

  test('refuses an api id that is not a positive integer', () => {
    for (const apiId of [0, -1, 1.5, 'abc', null, undefined, {}])
      expect(reject({ ...GOOD, apiId }).message).toContain('api id');
  });

  test('refuses an api hash that is not 32 hex characters', () => {
    for (const apiHash of ['', 'short', `${'z'.repeat(32)}`, 42, null])
      expect(reject({ ...GOOD, apiHash }).message).toContain('api hash');
  });

  test('refuses a phone that is not an international number', () => {
    for (const phone of ['', '123', 'not-a-phone', '0'.repeat(20), null])
      expect(reject({ ...GOOD, phone }).message).toContain('phone');
  });

  test('never repeats the rejected value back in the message', () => {
    expect(reject({ ...GOOD, apiHash: 'secret-looking-value' }).message).not.toContain(
      'secret-looking-value',
    );
  });
});

describe('reading Telegram RPC errors', () => {
  test('pulls the error text out of an mtcute RpcError shape', () => {
    expect(rpcErrorText({ text: 'PHONE_CODE_INVALID' })).toBe(
      'PHONE_CODE_INVALID',
    );
    expect(rpcErrorText(new Error('boom'))).toBe('');
    expect(rpcErrorText(null)).toBe('');
    expect(rpcErrorText('PHONE_CODE_INVALID')).toBe('');
  });

  test('recognises the two-step verification handoff', () => {
    expect(needsPassword({ text: 'SESSION_PASSWORD_NEEDED' })).toBe(true);
    expect(needsPassword({ text: 'PHONE_CODE_INVALID' })).toBe(false);
    expect(needsPassword(new Error('SESSION_PASSWORD_NEEDED'))).toBe(false);
  });

  test('turns the common failures into something a person can act on', () => {
    const cases: [string, string][] = [
      ['PHONE_CODE_INVALID', 'not right'],
      ['PHONE_CODE_EXPIRED', 'expired'],
      ['PHONE_NUMBER_INVALID', 'does not recognise'],
      ['PHONE_NUMBER_BANNED', 'banned'],
      ['PASSWORD_HASH_INVALID', 'password is not right'],
      ['FLOOD_WAIT_42', 'rate-limiting'],
    ];
    for (const [text, expected] of cases)
      expect(readableAuthError({ text })).toContain(expected);
  });

  test('an unrecognised failure still says something, never nothing', () => {
    expect(readableAuthError({ text: 'SOMETHING_NEW' })).toBe(
      'Telegram said SOMETHING_NEW',
    );
    expect(readableAuthError(new Error('socket hang up'))).toBe(
      'Telegram refused the sign-in',
    );
  });
});
