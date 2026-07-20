import { describe, expect, test } from 'bun:test';
import type { WAMessage } from '@whiskeysockets/baileys';
import {
  extractText,
  hasMedia,
  isGroupJid,
  isPrivateJid,
  toInbound,
  toReaction,
  tsToDate,
  type ReactionEvent,
} from '../src/parse.ts';

const asMessage = (m: unknown): WAMessage => m as WAMessage;

describe('jid helpers', () => {
  test('classifies dm vs group jids', () => {
    expect(isPrivateJid('111@s.whatsapp.net')).toBe(true);
    expect(isGroupJid('999-1@g.us')).toBe(true);
    expect(isGroupJid('111@s.whatsapp.net')).toBe(false);
  });
});

describe('tsToDate', () => {
  test('seconds number → date', () => {
    expect(tsToDate(1_700_000_000).getTime()).toBe(1_700_000_000_000);
  });
  test('Long-like → date', () => {
    expect(tsToDate({ toNumber: () => 1_700_000_000 }).getTime()).toBe(
      1_700_000_000_000,
    );
  });
});

describe('extractText / hasMedia', () => {
  test('plain conversation', () => {
    expect(extractText({ conversation: 'hi' })).toBe('hi');
  });
  test('extended text', () => {
    expect(extractText({ extendedTextMessage: { text: 'yo' } })).toBe('yo');
  });
  test('image caption', () => {
    expect(extractText({ imageMessage: { caption: 'cap' } })).toBe('cap');
    expect(hasMedia({ imageMessage: { caption: 'cap' } })).toBe(true);
  });
  test('no media', () => {
    expect(hasMedia({ conversation: 'hi' })).toBe(false);
  });
});

describe('toInbound', () => {
  test('DM message', () => {
    const m = asMessage({
      key: { remoteJid: '111@s.whatsapp.net', id: 'ABC', fromMe: false },
      message: { conversation: 'hello' },
      messageTimestamp: 1_700_000_000,
      pushName: 'Alice',
    });
    expect(toInbound('w0', m)).toEqual({
      accountId: 'w0',
      chatJid: '111@s.whatsapp.net',
      senderJid: '111@s.whatsapp.net',
      messageId: 'ABC',
      text: 'hello',
      date: new Date(1_700_000_000_000),
      isPrivate: true,
      pushName: 'Alice',
      hasMedia: false,
    });
  });

  test('group message resolves sender from participant and tags media', () => {
    const m = asMessage({
      key: {
        remoteJid: '999-1@g.us',
        id: 'DEF',
        fromMe: false,
        participant: '222@s.whatsapp.net',
      },
      message: { imageMessage: { caption: 'pic' } },
      messageTimestamp: 1_700_000_000,
    });
    const inbound = toInbound('w0', m);
    expect(inbound?.senderJid).toBe('222@s.whatsapp.net');
    expect(inbound?.isPrivate).toBe(false);
    expect(inbound?.hasMedia).toBe(true);
    expect(inbound?.text).toBe('pic [image]');
  });

  test('drops messages without a jid or id', () => {
    expect(
      toInbound('w0', asMessage({ key: { remoteJid: null, id: 'X' } })),
    ).toBeUndefined();
  });
});

describe('toReaction', () => {
  test('builds a reaction input', () => {
    const event: ReactionEvent = {
      key: { remoteJid: '999-1@g.us', id: 'ABC', fromMe: false },
      reaction: {
        text: '👍',
        key: { remoteJid: '999-1@g.us', id: 'RID', participant: '222@s.whatsapp.net', fromMe: false },
      },
    };
    const r = toReaction('w0', event);
    expect(r?.chatJid).toBe('999-1@g.us');
    expect(r?.senderJid).toBe('222@s.whatsapp.net');
    expect(r?.messageId).toBe('ABC');
    expect(r?.emoji).toBe('👍');
    expect(r?.removed).toBe(false);
  });

  test('empty text is a removal', () => {
    const event: ReactionEvent = {
      key: { remoteJid: '111@s.whatsapp.net', id: 'ABC', fromMe: false },
      reaction: { text: '' },
    };
    expect(toReaction('w0', event)?.removed).toBe(true);
  });

  test('skips our own reactions', () => {
    const event: ReactionEvent = {
      key: { remoteJid: '111@s.whatsapp.net', id: 'ABC', fromMe: false },
      reaction: { text: '👍', key: { fromMe: true } },
    };
    expect(toReaction('w0', event)).toBeUndefined();
  });
});
