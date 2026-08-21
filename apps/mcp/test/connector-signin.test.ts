import { describe, expect, test } from 'bun:test';
import { readConfig, signInState } from '../src/db/connector-config.ts';

const TOKENS = {
  kind: 'oauth',
  accessToken: 'at_live_7f',
  refreshToken: 'rt_live_7f',
  clientId: 'client_7f',
  tokenEndpoint: 'https://auth.example.com/token',
  issuer: 'https://auth.example.com',
};

const stateOf = (raw: unknown): ReturnType<typeof signInState> =>
  signInState(readConfig(raw));

describe('a connector reports whether it is signed in', () => {
  test('a row holding oauth tokens is connected', () => {
    expect(stateOf({ auth: TOKENS, oauth: true })).toBe('connected');
  });

  test('a header-auth row has no sign-in to report, so it offers no button', () => {
    expect(
      stateOf({ auth: { kind: 'header', name: 'Authorization', value: 'Bearer x' } }),
    ).toBe(null);
  });

  test('a no-auth row is not disconnected — it never signed in', () => {
    expect(stateOf({ auth: { kind: 'none' } })).toBe(null);
  });

  test('a row that signed in and was signed out reads as disconnected', () => {
    expect(stateOf({ auth: { kind: 'none' }, oauth: true })).toBe('disconnected');
  });

  test('a row predating the oauth flag is still connected on the strength of its tokens', () => {
    expect(stateOf({ auth: TOKENS })).toBe('connected');
    expect(readConfig({ auth: TOKENS }).oauth).toBe(true);
  });

  test('half a token set is no token set, so it does not read as connected', () => {
    const partial = { ...TOKENS, accessToken: '' };
    expect(stateOf({ auth: partial })).toBe(null);
    expect(stateOf({ auth: partial, oauth: true })).toBe('disconnected');
  });

  test('the flag alone never invents a header credential', () => {
    const config = readConfig({ auth: { kind: 'none' }, oauth: true });
    expect(config.auth).toEqual({ kind: 'none' });
  });

  test('an oauth value that is not literally true does not mark the row', () => {
    expect(stateOf({ auth: { kind: 'none' }, oauth: 'yes' })).toBe(null);
    expect(stateOf({ auth: { kind: 'none' }, oauth: 1 })).toBe(null);
  });

  test('a config that is not an object falls back to no sign-in', () => {
    expect(stateOf(null)).toBe(null);
    expect(stateOf('nonsense')).toBe(null);
  });
});
