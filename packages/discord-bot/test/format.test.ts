/**
 * Sender identity on inbound discord-bot envelopes. The relay surfaces the id-based
 * `from` (source of truth) alongside the handle (`from_name` = author username)
 * and the display name (`from_display_name` = author global_name). Here we lock
 * that the discord-bot station carries all three on messages and reactions, and
 * that the display name is left absent when the author has no global_name.
 */

import { describe, expect, test } from 'bun:test';
import type { Message, MessageReaction, User } from 'discord.js';
import { messageEnvelope, reactionEnvelope } from '../src/format.ts';
import { accounts } from '../src/accounts.ts';

const emptyCollection = { map: () => [], values: () => [].values() };

const noMentions = { has: () => false, repliedUser: null };

const fakeMessage = (author: Record<string, unknown>, mentions: Record<string, unknown> = noMentions): Message =>
  ({
    author: { bot: false, id: '999', ...author },
    mentions,
    attachments: emptyCollection,
    stickers: emptyCollection,
    content: 'hello',
    channelId: 'chan1',
    channel: { name: 'general' },
    createdTimestamp: 1_700_000_000_000,
    guildId: 'guild1',
    reference: null,
    flags: { has: () => false },
    toJSON: () => ({}),
  }) as unknown as Message;

describe('discord-bot messageEnvelope sender identity', () => {
  test('carries the id, username handle, and global_name display name', () => {
    const env = messageEnvelope(
      'd0',
      fakeMessage({ username: 'bonustrack_', globalName: 'less' }),
    );
    expect(env).not.toBeNull();
    expect(env?.from).toBe('metro://discord-bot/d0/user/999');
    expect(env?.from_name).toBe('bonustrack_');
    expect(env?.from_display_name).toBe('less');
  });

  test('leaves display name absent when global_name is null', () => {
    const env = messageEnvelope(
      'd0',
      fakeMessage({ username: 'coolcat', globalName: null }),
    );
    expect(env?.from_name).toBe('coolcat');
    expect(env?.from_display_name).toBeUndefined();
  });
});

describe('discord-bot reactionEnvelope sender identity', () => {
  test('carries the reactor handle and display name', () => {
    const u = {
      bot: false,
      id: '999',
      username: 'bonustrack_',
      globalName: 'less',
    } as unknown as User;
    const r = {
      message: { channelId: 'chan1', id: 'm1', guildId: 'guild1' },
      emoji: { name: '👍', id: null, toJSON: () => ({}) },
    } as unknown as MessageReaction;
    const env = reactionEnvelope('d0', r, u);
    expect(env).not.toBeNull();
    expect(env?.from_name).toBe('bonustrack_');
    expect(env?.from_display_name).toBe('less');
  });
});

describe('discord-bot messageEnvelope addressing facts', () => {
  test('a ping and a reply to the bot are reported separately, from the live client identity', () => {
    accounts.set('d0', { cfg: { id: 'd0', token: 't' }, client: { user: { id: 'bot1' } } } as never);
    try {
      const pinged = messageEnvelope('d0', fakeMessage({ username: 'x', globalName: null }, { has: () => true, repliedUser: null }));
      expect(pinged?.mentions_self).toBe(true);
      expect(pinged?.reply_to_self).toBe(false);
      const replied = messageEnvelope('d0', fakeMessage({ username: 'x', globalName: null }, { has: () => false, repliedUser: { id: 'bot1' } }));
      expect(replied?.mentions_self).toBe(false);
      expect(replied?.reply_to_self).toBe(true);
      const other = messageEnvelope('d0', fakeMessage({ username: 'x', globalName: null }, { has: () => false, repliedUser: { id: 'someone' } }));
      expect(other?.mentions_self).toBe(false);
      expect(other?.reply_to_self).toBe(false);
    } finally {
      accounts.delete('d0');
    }
  });

  test('without a live client neither fact is claimed', () => {
    const env = messageEnvelope('d9', fakeMessage({ username: 'x', globalName: null }, { has: () => true, repliedUser: { id: 'bot1' } }));
    expect(env?.mentions_self).toBe(false);
    expect(env?.reply_to_self).toBe(false);
  });
});
