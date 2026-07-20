import { describe, expect, test } from 'bun:test';
import { envelope, reactionEnvelope } from '../src/format.ts';
import type { InboundMessage, ReactionInput } from '../src/format.ts';

const dm = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  accountId: 'w0',
  chatJid: '111@s.whatsapp.net',
  senderJid: '111@s.whatsapp.net',
  messageId: 'ABC',
  text: 'hello',
  date: new Date('2026-06-21T00:00:00.000Z'),
  isPrivate: true,
  pushName: 'Alice',
  hasMedia: false,
  ...over,
});

describe('envelope', () => {
  test('DM text → private envelope', () => {
    const e = envelope(dm());
    expect(e.kind).toBe('inbound');
    expect(e.station).toBe('whatsapp');
    expect(e.line).toBe('metro://whatsapp/w0/111@s.whatsapp.net');
    expect(e.from).toBe('metro://whatsapp/w0/user/111@s.whatsapp.net');
    expect(e.from_name).toBe('Alice');
    expect(e.message_id).toBe('ABC');
    expect(e.text).toBe('hello');
    expect(e.is_private).toBe(true);
    expect(e.has_media).toBe(false);
    expect(e.payload).toEqual({ account: 'w0', message_id: 'ABC' });
  });

  test('group message scopes line to the group jid and sender participant', () => {
    const e = envelope(
      dm({
        chatJid: '999-1@g.us',
        senderJid: '222@s.whatsapp.net',
        isPrivate: false,
        pushName: 'Bob',
      }),
    );
    expect(e.line).toBe('metro://whatsapp/w0/999-1@g.us');
    expect(e.from).toBe('metro://whatsapp/w0/user/222@s.whatsapp.net');
    expect(e.is_private).toBe(false);
  });

  test('media sets has_media', () => {
    const e = envelope(dm({ text: '[image]', hasMedia: true }));
    expect(e.has_media).toBe(true);
    expect(e.text).toBe('[image]');
  });

  test('missing pushName omits from_name', () => {
    const e = envelope(dm({ pushName: undefined }));
    expect(e.from_name).toBeUndefined();
  });
});

describe('reactionEnvelope', () => {
  const base: ReactionInput = {
    accountId: 'w0',
    chatJid: '999-1@g.us',
    senderJid: '222@s.whatsapp.net',
    messageId: 'ABC',
    emoji: '👍',
    date: new Date('2026-06-21T00:00:00.000Z'),
    isPrivate: false,
    pushName: 'Bob',
  };

  test('normalizes a reaction', () => {
    const e = reactionEnvelope(base);
    expect(e.kind).toBe('react');
    expect(e.line).toBe('metro://whatsapp/w0/999-1@g.us');
    expect(e.message_id).toBe('ABC');
    expect(e.event).toEqual({ type: 'react', emoji: '👍', targetId: 'ABC' });
    expect(e.payload).toEqual({
      account: 'w0',
      message_id: 'ABC',
      removed: false,
    });
  });

  test('removed reaction sets payload.removed = true', () => {
    const e = reactionEnvelope({ ...base, emoji: '', removed: true });
    expect(e.payload).toEqual({
      account: 'w0',
      message_id: 'ABC',
      removed: true,
    });
  });
});
