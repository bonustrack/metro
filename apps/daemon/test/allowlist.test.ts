import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  allowlistForAccount,
  allowlistForLine,
  senderMatchesAllowlist,
  setAllowlistMap,
} from '../src/agents/map.ts';
import { normalizeAllowlist } from '../src/agents/allowlist.ts';
import { recentSenders } from '../src/agents/senders.ts';
import { publishEvent } from '@metro-labs/core/events';
import { Line } from '@metro-labs/core/lines';

describe('per-account allowlist', () => {
  beforeEach(() => setAllowlistMap({}));
  afterAll(() => setAllowlistMap({}));

  test('no allowlist configured for the account allows all senders', () => {
    expect(allowlistForLine('metro://discord-bot/d0/chan1')).toBeUndefined();
  });

  test('resolves the allowlist per account from the line', () => {
    setAllowlistMap({ 'xmtp/x0': ['abc123'] });
    expect(allowlistForLine('metro://xmtp/x0/conv1')).toEqual(['abc123']);
    expect(allowlistForLine('metro://xmtp/x1/conv1')).toBeUndefined();
  });

  test('empty allowlist or "*" allows all senders', () => {
    expect(senderMatchesAllowlist([], 'metro://xmtp/x0/user/abc')).toBe(true);
    expect(senderMatchesAllowlist(['*'], 'metro://xmtp/x0/user/abc')).toBe(true);
  });

  test('matches the sender id tail case-insensitively', () => {
    expect(senderMatchesAllowlist(['ABC'], 'metro://xmtp/x0/user/abc')).toBe(
      true,
    );
    expect(senderMatchesAllowlist(['abc'], 'metro://xmtp/x0/user/xyz')).toBe(
      false,
    );
  });
});

describe('domain entries', () => {
  const from = (address: string): string => `metro://outlook/o1/user/${address}`;

  test('an exact address still matches only that address', () => {
    expect(senderMatchesAllowlist(['andy@anderra.ch'], from('andy@anderra.ch'))).toBe(true);
    expect(senderMatchesAllowlist(['andy@anderra.ch'], from('bea@anderra.ch'))).toBe(false);
  });

  test('@domain matches everyone at that exact domain, in any case', () => {
    expect(senderMatchesAllowlist(['@Anderra.ch'], from('bea@anderra.ch'))).toBe(true);
    expect(senderMatchesAllowlist(['@anderra.ch'], from('Andy@ANDERRA.CH'))).toBe(true);
    expect(senderMatchesAllowlist(['@anderra.ch'], from('bea@example.ch'))).toBe(false);
  });

  test('a subdomain matches only when it is listed itself', () => {
    expect(senderMatchesAllowlist(['@anderra.ch'], from('x@mail.anderra.ch'))).toBe(false);
    expect(senderMatchesAllowlist(['@mail.anderra.ch'], from('x@mail.anderra.ch'))).toBe(true);
    expect(senderMatchesAllowlist(['@anderra.ch'], from('x@notanderra.ch'))).toBe(false);
  });

  test('"*" still means anyone, and a sender id that is not an address never matches a domain', () => {
    expect(senderMatchesAllowlist(['@anderra.ch', '*'], from('x@y.z'))).toBe(true);
    expect(senderMatchesAllowlist(['@anderra.ch'], 'metro://telegram-bot/t0/user/anderra.ch')).toBe(false);
    expect(senderMatchesAllowlist(['@anderra.ch'], 'metro://xmtp/x0/user/0xabc@anderra.ch@x')).toBe(false);
  });

  test('saving keeps a domain entry in lower case and refuses a bare @ or a non-domain', () => {
    expect(normalizeAllowlist(['@Anderra.CH', 'bea@example.ch'])).toEqual(['@anderra.ch', 'bea@example.ch']);
    expect(() => normalizeAllowlist(['@'])).toThrow('is not a domain');
    expect(() => normalizeAllowlist(['@localhost'])).toThrow('is not a domain');
  });
});

describe('what the page may put in an allowlist', () => {
  afterAll(() => setAllowlistMap({}));
  test('entries are trimmed, deduped case-insensitively, and an empty list means everyone', () => {
    expect(normalizeAllowlist([' 4242 ', 'Ada', 'ada', ''])).toEqual(['4242', 'Ada']);
    expect(normalizeAllowlist([])).toEqual(['*']);
    expect(normalizeAllowlist(['   '])).toEqual(['*']);
    expect(normalizeAllowlist(['4242', '*'])).toEqual(['*']);
  });

  test('anything that is not a list of plain, short strings is refused, so nothing odd reaches the agent file', () => {
    expect(() => normalizeAllowlist('ada')).toThrow(/list of sender ids/);
    expect(() => normalizeAllowlist([42])).toThrow(/list of sender ids/);
    expect(() => normalizeAllowlist(['a'.repeat(201)])).toThrow(/at most 200/);
    expect(() => normalizeAllowlist(['bad\u0007id'])).toThrow(/plain characters/);
    expect(() => normalizeAllowlist(Array.from({ length: 501 }, (_, i) => String(i)))).toThrow(/at most 500/);
  });

  test('an allowlist is readable by account, which is what the station page shows', () => {
    setAllowlistMap({ 'telegram-bot/t0': ['4242'] });
    expect(allowlistForAccount('telegram-bot', 't0')).toEqual(['4242']);
    expect(allowlistForAccount('telegram-bot', 't1')).toBeUndefined();
  });
});

describe('the senders the page offers', () => {
  test('the newest sender on that account comes first, with its display name, and self, unknown and other accounts are left out', () => {
    const at = '2026-09-10T09:00:00.000Z';
    const post = (from: string, fromDisplayName?: string): void => {
      publishEvent({
        id: from,
        ts: at,
        station: 'telegram-bot',
        line: Line.parse('metro://telegram-bot/t0/chat/1') ?? ('metro://telegram-bot/t0/chat/1' as unknown as Line),
        from: from as unknown as Line,
        to: 'metro://telegram-bot/t0/chat/1' as unknown as Line,
        ...(fromDisplayName === undefined ? {} : { fromDisplayName }),
        text: 'hi',
      });
    };
    post('metro://telegram-bot/t0/user/4242', 'Ada');
    post('metro://telegram-bot/t0/user/4242', 'Ada');
    post('metro://telegram-bot/t0/user/7', 'Bob');
    post('metro://telegram-bot/t0/self');
    post('metro://telegram-bot/other/user/9', 'Elsewhere');
    const senders = recentSenders('telegram-bot', 't0');
    expect(senders.map((s) => s.id)).toEqual(['7', '4242']);
    expect(senders[0]).toEqual({ id: '7', name: 'Bob', at });
    expect(recentSenders('telegram-bot', 't0', 1).map((s) => s.id)).toEqual(['7']);
  });
});
