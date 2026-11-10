import { describe, expect, test } from 'bun:test';
import { normalizeSenderList, senderVerdict } from '@metro-labs/http/sender-list';
import { normalizeAllowlist } from '../src/agents/allowlist.ts';
import { senderPermitted } from '../src/agents/map.ts';

const LISTS: string[][] = [['*'], [], ['boss@example.com'], ['Boss@Example.com', 'U123'], ['@example.com'], ['@example.com', 'friend@other.org'], ['@']];
const SENDERS = ['boss@example.com', 'BOSS@EXAMPLE.COM', 'stranger@example.com', 'x@mail.example.com', 'friend@other.org', 'u123', 'example.com', '@example.com', 'nobody'];
const VERIFIED = [undefined, true, false];

describe('who can write on a connector matches like a channel allowlist', () => {
  test('every list, sender and verified flag gets the same answer from both', () => {
    for (const list of LISTS) {
      for (const sender of SENDERS) {
        for (const verified of VERIFIED) {
          const channel = senderPermitted(list, `metro://gmail/acct1/user/${sender}`, verified);
          const connector = senderVerdict(list, { id: sender, ...(verified === undefined ? {} : { verified }) }) === 'allow';
          expect([list, sender, verified, connector]).toEqual([list, sender, verified, channel]);
        }
      }
    }
  });

  test('a list is normalized the same way at save', () => {
    for (const raw of [[' Boss@Example.com ', 'boss@example.com', '@Example.COM', ''], ['a@b.c', '*'], [], ['U123', 'u123', 'V9']]) expect(normalizeSenderList(raw)).toEqual(normalizeAllowlist(raw));
    for (const bad of [['@'], ['@nodot'], ['x'.repeat(201)], ['a\nb'], [5], 'x']) {
      expect(() => normalizeSenderList(bad)).toThrow();
      expect(() => normalizeAllowlist(bad)).toThrow();
    }
  });
});
