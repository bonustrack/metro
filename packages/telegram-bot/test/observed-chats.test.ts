import { describe, expect, test } from 'bun:test';
import { DIRECTORY_LIMIT } from '@metro-labs/core/stations/channel-directory';
import { ObservedChats } from '../src/observed-chats.ts';
import type { TgChat, TgMsg, TgUpdate } from '../src/types.ts';

const group: TgChat = { id: -10001, type: 'supergroup', title: 'Engineering' };
const message = (chat: TgChat, extra: Partial<TgMsg> = {}): TgUpdate => ({
  update_id: 1,
  message: { message_id: 7, date: 1_700_000_000, chat, ...extra },
});

function membership(chat: TgChat, status: string, is_member?: boolean): TgUpdate {
  return { update_id: 2, my_chat_member: { chat, new_chat_member: { status, is_member } } };
}

const topic = (book: ObservedChats): void => book.observe(message(group, {
  is_topic_message: true,
  message_thread_id: 12,
  forum_topic_created: { name: 'Release notes' },
}));

describe('telegram-bot observed chat metadata', () => {
  test('projects private, group, channel and topic metadata without bodies or senders', () => {
    const book = new ObservedChats('bot-a');
    book.observe(message({ id: 42, type: 'private', first_name: ' Ada ', last_name: 'Lovelace', username: 'ada' }, {
      from: { id: 777, first_name: 'Not a chat' }, text: 'private body', document: { file_id: 'secret-file' },
    }));
    topic(book);
    book.observe({
      update_id: 3,
      channel_post: { message_id: 8, date: 1, chat: { id: -20001, type: 'channel', title: 'News' }, caption: 'private caption' },
    });
    expect(book.snapshot().channels).toEqual([
      { id: '42', line: 'metro://telegram-bot/bot-a/42', kind: 'direct', name: 'Ada Lovelace' },
      { id: '-10001', line: 'metro://telegram-bot/bot-a/-10001', kind: 'group', name: 'Engineering' },
      { id: '-10001/12', line: 'metro://telegram-bot/bot-a/-10001/12', kind: 'thread', name: 'Release notes' },
      { id: '-20001', line: 'metro://telegram-bot/bot-a/-20001', kind: 'channel', name: 'News' },
    ]);
    expect(book.snapshot().capability).toMatchObject({ supported: true, complete: false, source: 'local' });
    expect(book.snapshot().capability.reason).toContain('no all-chats API');
    expect(book.snapshot().capability.reason).toContain('5000');
  });

  test('keeps names on sparse reaction updates and changes them only from chat metadata', () => {
    const book = new ObservedChats('bot-a');
    book.observe(message(group));
    book.observe({
      update_id: 2,
      message_reaction: { chat: { id: group.id, type: group.type }, message_id: 4, date: 1, old_reaction: [], new_reaction: [] },
    });
    expect(book.snapshot().channels[0]?.name).toBe('Engineering');
    book.observe({
      update_id: 3,
      message_reaction_count: { chat: { ...group, title: 'Engineering renamed' }, message_id: 4, date: 1, reactions: [] },
    });
    expect(book.snapshot().channels[0]?.name).toBe('Engineering renamed');
  });

  test('uses private chat metadata only and bounds names', () => {
    const book = new ObservedChats('bot-a');
    book.observe(message({ id: 1, type: 'private', username: 'ada' }));
    book.observe(message({ id: 2, type: 'private' }, { from: { id: 99, first_name: 'Sender only' } }));
    book.observe(message({ id: -2, type: 'group', title: 'A'.repeat(500) }));
    expect(book.snapshot().channels[0]?.name).toBe('@ada');
    expect(book.snapshot().channels[1]?.name).toBeUndefined();
    expect(book.snapshot().channels[2]?.name).toHaveLength(256);
  });

  test('observes forum names only from topic metadata, not message text or reply threads', () => {
    const book = new ObservedChats('bot-a');
    topic(book);
    book.observe(message(group, { is_topic_message: true, message_thread_id: 12, text: 'not a topic name' }));
    expect(book.snapshot().channels.find((entry) => entry.kind === 'thread')?.name).toBe('Release notes');
    book.observe(message(group, { is_topic_message: true, message_thread_id: 12, forum_topic_edited: { name: 'Renamed topic' } }));
    book.observe(message(group, { message_thread_id: 14, text: 'ordinary reply' }));
    const threads = book.snapshot().channels.filter((entry) => entry.kind === 'thread');
    expect(threads).toEqual([{ id: '-10001/12', line: 'metro://telegram-bot/bot-a/-10001/12', kind: 'thread', name: 'Renamed topic' }]);
  });

  test('removes departed chats and all topics, then allows an observed rejoin', () => {
    for (const [status, isMember] of [['left', undefined], ['kicked', undefined], ['restricted', false]] as const) {
      const book = new ObservedChats('bot-a');
      topic(book);
      book.observe(membership(group, status, isMember));
      expect(book.snapshot().channels).toEqual([]);
      book.observe(membership({ ...group, title: 'Rejoined' }, 'member'));
      expect(book.snapshot().channels).toEqual([{ id: '-10001', line: 'metro://telegram-bot/bot-a/-10001', kind: 'group', name: 'Rejoined' }]);
    }
  });

  test('records active bot membership without turning member users into chats', () => {
    const book = new ObservedChats('bot-a');
    for (const status of ['creator', 'administrator', 'member']) book.observe(membership(group, status));
    book.observe(membership({ id: 42, type: 'private', first_name: 'Ada' }, 'restricted', true));
    book.observe(membership({ id: -3, type: 'channel', title: 'Unknown state' }, 'unknown'));
    expect(book.snapshot().channels.map((entry) => entry.id)).toEqual(['-10001', '42']);
  });

  test('replaces migrated group lines and removes obsolete topics from either migration direction', () => {
    const book = new ObservedChats('bot-a');
    topic(book);
    book.observe(message(group, { migrate_to_chat_id: -10002 }));
    expect(book.snapshot().channels).toEqual([{ id: '-10002', line: 'metro://telegram-bot/bot-a/-10002', kind: 'group', name: 'Engineering' }]);
    topic(book);
    book.observe(message({ id: -10002, type: 'supergroup', title: 'Migrated' }, { migrate_from_chat_id: group.id }));
    expect(book.snapshot().channels).toEqual([{ id: '-10002', line: 'metro://telegram-bot/bot-a/-10002', kind: 'group', name: 'Migrated' }]);
  });

  test('caps the account-local directory and evicts the least recently observed entry', () => {
    const book = new ObservedChats('bot-a');
    for (let id = 1; id <= DIRECTORY_LIMIT; id++) book.observe(message({ id, type: 'private' }));
    book.observe(message({ id: 1, type: 'private' }));
    book.observe(message({ id: DIRECTORY_LIMIT + 1, type: 'private' }));
    const snapshot = book.snapshot();
    expect(snapshot.channels).toHaveLength(DIRECTORY_LIMIT);
    expect(snapshot.channels.some((entry) => entry.id === '1')).toBe(true);
    expect(snapshot.channels.some((entry) => entry.id === '2')).toBe(false);
    expect(snapshot.capability.complete).toBe(false);
  });

  test('ignores unknown chat kinds and unsafe IDs', () => {
    const book = new ObservedChats('bot-a');
    for (const id of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) book.observe(message({ id, type: 'private' }));
    book.observe(message({ id: 3, type: 'unknown' }));
    expect(book.snapshot().channels).toEqual([]);
  });
});
