import { describe, expect, test } from 'bun:test';
import type { WAMessage } from '@whiskeysockets/baileys';
import {
  extractText,
  isGroupJid,
  isPrivateJid,
  mediaRefOf,
  toInbound,
  toReaction,
  tsToDate,
  unwrap,
  type ReactionEvent,
} from '../src/parse.ts';

const hasMedia = (m: unknown): boolean =>
  mediaRefOf(m as Parameters<typeof mediaRefOf>[0]) !== undefined;

const asMessage = (m: unknown): WAMessage => m as WAMessage;

describe('jid helpers', () => {
  test('classifies dm vs group jids', () => {
    expect(isPrivateJid('111@s.whatsapp.net')).toBe(true);
    expect(isGroupJid('999-1@g.us')).toBe(true);
    expect(isGroupJid('111@s.whatsapp.net')).toBe(false);
  });

  test('a 1:1 carried over lid addressing is still private', () => {
    expect(isPrivateJid('71425507483880@lid')).toBe(true);
    expect(isGroupJid('71425507483880@lid')).toBe(false);
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
  test('ephemeral-wrapped conversation', () => {
    expect(
      extractText({ ephemeralMessage: { message: { conversation: 'ghost' } } }),
    ).toBe('ghost');
  });
  test('viewOnceV2-wrapped image caption', () => {
    const m = { viewOnceMessageV2: { message: { imageMessage: { caption: 'once' } } } };
    expect(extractText(m)).toBe('once');
    expect(hasMedia(m)).toBe(true);
  });
  test('deviceSent-wrapped extended text', () => {
    expect(
      extractText({
        deviceSentMessage: { message: { extendedTextMessage: { text: 'dev' } } },
      }),
    ).toBe('dev');
  });
  test('nested ephemeral+viewOnce unwraps fully', () => {
    expect(
      extractText({
        ephemeralMessage: {
          message: { viewOnceMessageV2: { message: { conversation: 'deep' } } },
        },
      }),
    ).toBe('deep');
  });
});

describe('unwrap', () => {
  test('returns leaf message through envelopes', () => {
    expect(
      unwrap({ ephemeralMessage: { message: { conversation: 'x' } } }),
    ).toEqual({ conversation: 'x' });
  });
  test('plain message passes through', () => {
    expect(unwrap({ conversation: 'y' })).toEqual({ conversation: 'y' });
  });
  test('nullish → undefined', () => {
    expect(unwrap(null)).toBeUndefined();
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
    expect(inbound?.media?.kind).toBe('image');
    expect(inbound?.text).toBe('pic [image]');
  });

  test('a lid 1:1 message is private and its sender is the chat itself', () => {
    const m = asMessage({
      key: { remoteJid: '71425507483880@lid', id: 'LID1', fromMe: false },
      message: { conversation: 'Here??' },
      messageTimestamp: 1_700_000_000,
      pushName: 'Fabien',
    });
    const inbound = toInbound('a2', m);
    expect(inbound?.isPrivate).toBe(true);
    expect(inbound?.senderJid).toBe('71425507483880@lid');
  });

  test('drops messages without a jid or id', () => {
    expect(
      toInbound('w0', asMessage({ key: { remoteJid: null, id: 'X' } })),
    ).toBeUndefined();
  });

  test('unwraps an ephemeral-wrapped inbound message', () => {
    const m = asMessage({
      key: { remoteJid: '111@s.whatsapp.net', id: 'EPH', fromMe: false },
      message: { ephemeralMessage: { message: { conversation: 'secret' } } },
      messageTimestamp: 1_700_000_000,
    });
    expect(toInbound('w0', m)?.text).toBe('secret');
  });

  test('skips a reaction message (handled via reaction path)', () => {
    const m = asMessage({
      key: { remoteJid: '111@s.whatsapp.net', id: 'RX', fromMe: false },
      message: { reactionMessage: { text: '👍', key: { id: 'ABC' } } },
      messageTimestamp: 1_700_000_000,
    });
    expect(toInbound('w0', m)).toBeUndefined();
  });

  test('skips protocol-only / senderKeyDistribution messages', () => {
    const proto = asMessage({
      key: { remoteJid: '111@s.whatsapp.net', id: 'P1', fromMe: false },
      message: { protocolMessage: { type: 0 } },
      messageTimestamp: 1_700_000_000,
    });
    const skd = asMessage({
      key: { remoteJid: '999-1@g.us', id: 'P2', fromMe: false },
      message: { senderKeyDistributionMessage: { groupId: '999-1@g.us' } },
      messageTimestamp: 1_700_000_000,
    });
    expect(toInbound('w0', proto)).toBeUndefined();
    expect(toInbound('w0', skd)).toBeUndefined();
  });

  test('media without caption surfaces a placeholder tag', () => {
    const m = asMessage({
      key: { remoteJid: '111@s.whatsapp.net', id: 'IMG', fromMe: false },
      message: { imageMessage: {} },
      messageTimestamp: 1_700_000_000,
    });
    const inbound = toInbound('w0', m);
    expect(inbound?.text).toBe('[image]');
    expect(inbound?.media?.kind).toBe('image');
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
