/**
 * Sender identity on inbound telegram-bot envelopes. The relay surfaces the id-based
 * `from` (source of truth) alongside the handle (`from_name` = @username, else
 * first_name) and the display name (`from_display_name` = first_name). Here we
 * lock that the telegram-bot station carries both on messages and reactions.
 */

import { describe, expect, test } from 'bun:test';
import { envelope, reactionEnvelope } from '../src/format.ts';
import { accounts } from '../src/accounts.ts';
import type { TgMsg, TgReaction } from '../src/types.ts';

const baseMsg = (over: Partial<TgMsg['from']> = {}): TgMsg => ({
  message_id: 7,
  date: 1_700_000_000,
  chat: { id: -100123, type: 'supergroup', title: 'Devs' },
  from: { id: 555, username: 'alice', first_name: 'Alice', ...over },
  text: 'hi',
});

describe('telegram-bot envelope sender identity', () => {
  test('handle prefers @username, display name is first_name', () => {
    const env = envelope('t0', baseMsg());
    expect(env.from).toBe('metro://telegram-bot/t0/user/555');
    expect(env.from_name).toBe('@alice');
    expect(env.from_display_name).toBe('Alice');
  });

  test('handle falls back to first_name when no username', () => {
    const env = envelope('t0', baseMsg({ username: undefined, first_name: 'Bob' }));
    expect(env.from_name).toBe('Bob');
    expect(env.from_display_name).toBe('Bob');
  });
});

describe('telegram-bot reactionEnvelope sender identity', () => {
  test('carries the reactor handle and display name', () => {
    const r: TgReaction = {
      chat: { id: -100123, type: 'supergroup' },
      message_id: 42,
      user: { id: 555, username: 'alice', first_name: 'Alice' },
      date: 1_700_000_000,
      old_reaction: [],
      new_reaction: [{ type: 'emoji', emoji: '🔥' }],
    };
    const env = reactionEnvelope('t0', r);
    expect(env).not.toBeNull();
    expect(env?.from_name).toBe('@alice');
    expect(env?.from_display_name).toBe('Alice');
  });
});

describe('telegram-bot envelope addressing facts', () => {
  const withBot = <T>(run: () => T): T => {
    accounts.set('t0', { cfg: { id: 't0', token: '12345:abc' }, api: '', fileApi: '', offset: 0, username: 'TonyBot' });
    try {
      return run();
    } finally {
      accounts.delete('t0');
    }
  };

  test('a reply to the bot is known from the token prefix, a reply to anyone else only carries the target', () => {
    withBot(() => {
      const mine = envelope('t0', { ...baseMsg(), reply_to_message: { message_id: 41, from: { id: 12345, is_bot: true } } });
      expect(mine.reply_to).toBe('41');
      expect(mine.event).toEqual({ type: 'reply', replyTo: '41' });
      expect(mine.reply_to_self).toBe(true);
      const theirs = envelope('t0', { ...baseMsg(), reply_to_message: { message_id: 42, from: { id: 777 } } });
      expect(theirs.reply_to).toBe('42');
      expect(theirs.reply_to_self).toBe(false);
    });
  });

  test('an @mention of the bot or a text mention of its id is a mention; other handles are not', () => {
    withBot(() => {
      const named = envelope('t0', { ...baseMsg(), text: 'hey @tonybot look', entities: [{ type: 'mention', offset: 4, length: 8 }] });
      expect(named.mentions_self).toBe(true);
      const idOnly = envelope('t0', { ...baseMsg(), text: 'hey Tony', entities: [{ type: 'text_mention', offset: 4, length: 4, user: { id: 12345 } }] });
      expect(idOnly.mentions_self).toBe(true);
      const someone = envelope('t0', { ...baseMsg(), text: 'hey @alice', entities: [{ type: 'mention', offset: 4, length: 6 }] });
      expect(someone.mentions_self).toBe(false);
    });
  });

  test('the topic root a forum message hangs off is not a reply, and an unknown account claims nothing', () => {
    withBot(() => {
      const topic = envelope('t0', { ...baseMsg(), is_topic_message: true, message_thread_id: 5, reply_to_message: { message_id: 5, from: { id: 12345 } } });
      expect(topic.reply_to).toBeUndefined();
      expect(topic.reply_to_self).toBe(false);
    });
    const unknown = envelope('t9', { ...baseMsg(), reply_to_message: { message_id: 41, from: { id: 12345 } } });
    expect(unknown.reply_to).toBe('41');
    expect(unknown.reply_to_self).toBe(false);
    expect(unknown.mentions_self).toBe(false);
  });
});
