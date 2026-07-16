import { describe, expect, test } from 'bun:test';
import type { Message } from '@mtcute/bun';
import {
  attachmentSavedEnvelope,
  envelope,
  isOwnEcho,
  reactionEnvelope,
} from '../src/format.js';

interface FakeUser {
  type: 'user';
  id: number;
  isSelf: boolean;
  username: string | null;
  firstName: string;
}

interface FakeChat {
  type: 'chat';
  id: number;
  title: string;
}

interface FakeMessage {
  id: number;
  isOutgoing: boolean;
  date: Date;
  text: string;
  isTopicMessage: boolean;
  replyToMessage: { threadId: number | null } | null;
  media: { type: string } | null;
  sender: FakeUser | FakeChat;
  chat: FakeUser | FakeChat;
}

const asMessage = (m: FakeMessage): Message => m as unknown as Message;

const user = (over: Partial<FakeUser> = {}): FakeUser => ({
  type: 'user',
  id: 111,
  isSelf: false,
  username: 'alice',
  firstName: 'Alice',
  ...over,
});

const dmMessage = (): FakeMessage => ({
  id: 42,
  isOutgoing: false,
  date: new Date('2026-06-21T00:00:00.000Z'),
  text: 'hello',
  isTopicMessage: false,
  replyToMessage: null,
  media: null,
  sender: user(),
  chat: user(),
});

const groupTopicMessage = (): FakeMessage => ({
  id: 99,
  isOutgoing: false,
  date: new Date('2026-06-21T00:00:00.000Z'),
  text: 'in topic',
  isTopicMessage: true,
  replyToMessage: { threadId: 7 },
  media: null,
  sender: user({ id: 222, username: null, firstName: 'Bob' }),
  chat: { type: 'chat', id: -1009, title: 'Devs' },
});

describe('envelope', () => {
  test('DM text → private envelope', () => {
    const e = envelope('default', asMessage(dmMessage()));
    expect(e.kind).toBe('inbound');
    expect(e.station).toBe('telegram-user');
    expect(e.line).toBe('metro://telegram-user/default/111');
    expect(e.from).toBe('metro://telegram-user/default/user/111');
    expect(e.from_name).toBe('@alice');
    expect(e.from_display_name).toBe('Alice');
    expect(e.message_id).toBe('42');
    expect(e.text).toBe('hello');
    expect(e.is_private).toBe(true);
    expect(e.has_media).toBe(false);
  });

  test('group text with topic → line carries topic id', () => {
    const e = envelope('work', asMessage(groupTopicMessage()));
    expect(e.line).toBe('metro://telegram-user/work/-1009/7');
    expect(e.line_name).toBe('Devs');
    expect(e.from).toBe('metro://telegram-user/work/user/222');
    expect(e.from_name).toBe('Bob');
    expect(e.from_display_name).toBe('Bob');
    expect(e.is_private).toBe(false);
  });

  test('media message tags text and sets has_media', () => {
    const m = dmMessage();
    m.text = '';
    m.media = { type: 'photo' };
    const e = envelope('default', asMessage(m));
    expect(e.text).toBe('[photo]');
    expect(e.has_media).toBe(true);
  });
});

describe('isOwnEcho', () => {
  test('outgoing message is an echo', () => {
    const m = dmMessage();
    m.isOutgoing = true;
    expect(isOwnEcho(asMessage(m))).toBe(true);
  });

  test('self sender is an echo', () => {
    const m = dmMessage();
    m.sender = user({ isSelf: true });
    expect(isOwnEcho(asMessage(m))).toBe(true);
  });

  test('incoming from other user is not an echo', () => {
    expect(isOwnEcho(asMessage(dmMessage()))).toBe(false);
  });
});

describe('attachmentSavedEnvelope', () => {
  test('mirrors the canonical attachmentSaved follow-up shape', () => {
    const e = attachmentSavedEnvelope(
      'default',
      'metro://telegram-user/default/111',
      'envid-123',
      { path: '/cache/msg_42_0.jpg', mime: 'image/jpeg', name: 'pic.jpg', bytes: 9 },
    );
    expect(e.kind).toBe('inbound');
    expect(e.station).toBe('telegram-user');
    expect(e.line).toBe('metro://telegram-user/default/111');
    expect(e.from).toBe('metro://telegram-user/default/self');
    expect(e.text).toBe('📎 saved: /cache/msg_42_0.jpg');
    expect(e.payload).toEqual({
      account: 'default',
      contentType: 'attachmentSaved',
      attachmentFor: 'envid-123',
      index: 0,
      attachmentPath: '/cache/msg_42_0.jpg',
      localPath: '/cache/msg_42_0.jpg',
      mime: 'image/jpeg',
      name: 'pic.jpg',
    });
  });
});

describe('reactionEnvelope', () => {
  test('normalizes a reaction update', () => {
    const e = reactionEnvelope({
      accountId: 'default',
      chatId: -1009,
      messageId: 99,
      emoji: '👍',
      senderId: 222,
      date: new Date('2026-06-21T00:00:00.000Z'),
      isPrivate: false,
      senderName: 'Bob',
    });
    expect(e.kind).toBe('react');
    expect(e.line).toBe('metro://telegram-user/default/-1009');
    expect(e.message_id).toBe('99');
    expect(e.event).toEqual({ type: 'react', emoji: '👍', targetId: '99' });
    expect(e.payload).toEqual({
      account: 'default',
      message_id: '99',
      removed: false,
    });
  });

  test('removed reaction sets payload.removed = true', () => {
    const e = reactionEnvelope({
      accountId: 'default',
      chatId: -1009,
      messageId: 99,
      emoji: '👍',
      senderId: 222,
      date: new Date('2026-06-21T00:00:00.000Z'),
      isPrivate: false,
      removed: true,
    });
    expect(e.payload).toEqual({
      account: 'default',
      message_id: '99',
      removed: true,
    });
  });
});
