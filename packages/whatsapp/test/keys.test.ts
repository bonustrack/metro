import { describe, expect, test } from 'bun:test';
import type { WAMessageKey } from 'baileys';
import { knownKey, makeKeyCache, targetKey } from '../src/keys.ts';

const GROUP = '120363430375655034@g.us';
const DM = '19453952815@s.whatsapp.net';
const LID_DM = '156277451812885@lid';

const groupKey = (id: string, participant: string): WAMessageKey => ({
  remoteJid: GROUP,
  fromMe: false,
  id,
  participant,
});

describe('whatsapp message key cache', () => {
  test('a remembered group key is returned verbatim, participant and all', () => {
    const cache = makeKeyCache();
    const key = groupKey('M1', '156277451812885@lid');
    cache.remember(key);
    expect(targetKey(cache, GROUP, 'M1', 'react to')).toEqual(key);
  });

  test('our own message keeps fromMe true when reacted to', () => {
    const cache = makeKeyCache();
    cache.remember({ remoteJid: GROUP, fromMe: true, id: 'MINE' });
    expect(targetKey(cache, GROUP, 'MINE', 'react to')).toEqual({
      remoteJid: GROUP,
      fromMe: true,
      id: 'MINE',
    });
  });

  test('an unknown group message is refused, never sent with a guessed key', () => {
    const cache = makeKeyCache();
    expect(() => targetKey(cache, GROUP, 'GHOST', 'react to')).toThrow(
      /never saw that message/,
    );
    expect(() => targetKey(cache, GROUP, 'GHOST', 'react to')).toThrow(
      /GHOST/,
    );
  });

  test('an unknown 1:1 message still falls back to the peer-authored key', () => {
    const cache = makeKeyCache();
    expect(targetKey(cache, DM, 'ABC', 'react to')).toEqual({
      remoteJid: DM,
      id: 'ABC',
      fromMe: false,
    });
    expect(targetKey(cache, LID_DM, 'ABC', 'react to')).toEqual({
      remoteJid: LID_DM,
      id: 'ABC',
      fromMe: false,
    });
  });

  test('the same message id in two chats does not collide', () => {
    const cache = makeKeyCache();
    const inGroup = groupKey('SAME', '1@lid');
    cache.remember(inGroup);
    cache.remember({ remoteJid: DM, fromMe: true, id: 'SAME' });
    expect(cache.lookup(GROUP, 'SAME')).toEqual(inGroup);
    expect(cache.lookup(DM, 'SAME')).toEqual({
      remoteJid: DM,
      fromMe: true,
      id: 'SAME',
    });
  });

  test('keys without an id or a chat are ignored', () => {
    const cache = makeKeyCache();
    cache.remember(undefined);
    cache.remember(null);
    cache.remember({ remoteJid: GROUP, fromMe: false });
    cache.remember({ id: 'X', fromMe: false });
    expect(cache.lookup(GROUP, 'X')).toBeUndefined();
  });

  test('the cache is bounded and evicts oldest first', () => {
    const cache = makeKeyCache(2);
    cache.remember(groupKey('A', '1@lid'));
    cache.remember(groupKey('B', '1@lid'));
    cache.remember(groupKey('C', '1@lid'));
    expect(cache.lookup(GROUP, 'A')).toBeUndefined();
    expect(cache.lookup(GROUP, 'B')).toBeDefined();
    expect(cache.lookup(GROUP, 'C')).toBeDefined();
  });

  test('re-remembering a key refreshes it rather than duplicating it', () => {
    const cache = makeKeyCache(2);
    cache.remember(groupKey('A', '1@lid'));
    cache.remember(groupKey('B', '1@lid'));
    cache.remember(groupKey('A', '2@lid'));
    cache.remember(groupKey('C', '1@lid'));
    expect(cache.lookup(GROUP, 'A')).toEqual(groupKey('A', '2@lid'));
    expect(cache.lookup(GROUP, 'B')).toBeUndefined();
  });

  test('knownKey prefers the remembered key over the requested fromMe', () => {
    const cache = makeKeyCache();
    const key = groupKey('Q', '9@lid');
    cache.remember(key);
    expect(knownKey(cache, GROUP, 'Q', true)).toEqual(key);
    expect(knownKey(cache, GROUP, 'MISSING', true)).toEqual({
      remoteJid: GROUP,
      id: 'MISSING',
      fromMe: true,
    });
  });
});
