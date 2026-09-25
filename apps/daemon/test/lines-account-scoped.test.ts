import { describe, expect, test } from 'bun:test';
import { Line } from '@metro-labs/core/lines';

describe('Line.parseXmtp', () => {
  test('new account-scoped form → {accountId, resource}', () => {
    expect(Line.parseXmtp('metro://xmtp/tony/0xconv')).toEqual({ accountId: 'tony', resource: '0xconv' });
    expect(Line.parseXmtp('metro://xmtp/ben/0xabc')).toEqual({ accountId: 'ben', resource: '0xabc' });
  });

  test('a line without an account → null', () => {
    expect(Line.parseXmtp('metro://xmtp/0xconv')).toBeNull();
  });

  test('three or more segments → null (matches old anchored regex)', () => {
    expect(Line.parseXmtp('metro://xmtp/tony/group/0xdef')).toBeNull();
  });

  test('wrong station → null', () => {
    expect(Line.parseXmtp('metro://discord-bot/123')).toBeNull();
  });

  test('malformed input → null', () => {
    expect(Line.parseXmtp('garbage')).toBeNull();
    expect(Line.parseXmtp('metro://xmtp')).toBeNull();
  });

  test('round-trips with the train builder', () => {
    expect(Line.parseXmtp('metro://xmtp/tony/0xc')).toEqual({ accountId: 'tony', resource: '0xc' });
  });
});

describe('Line.parseDiscord', () => {
  test('new account-scoped form (snowflake channel) → {accountId, resource}', () => {
    expect(Line.parseDiscord('metro://discord-bot/main/123456')).toEqual({ accountId: 'main', resource: '123456' });
  });

  test('a snowflake without an account → null', () => {
    expect(Line.parseDiscord('metro://discord-bot/123456')).toBeNull();
  });

  test('non-numeric channel (resource) → null', () => {
    expect(Line.parseDiscord('metro://discord-bot/main/not-a-snowflake')).toBeNull();
    expect(Line.parseDiscord('metro://discord-bot/not-a-snowflake')).toBeNull();
  });

  test('three or more segments → null', () => {
    expect(Line.parseDiscord('metro://discord-bot/main/sub/123')).toBeNull();
  });

  test('wrong station / malformed → null', () => {
    expect(Line.parseDiscord('metro://xmtp/123')).toBeNull();
    expect(Line.parseDiscord('garbage')).toBeNull();
  });
});
