/**
 * Sender identity on inbound discord envelopes. The relay surfaces the id-based
 * `from` (source of truth) alongside the handle (`from_name` = author username)
 * and the display name (`from_display_name` = author global_name). Here we lock
 * that the discord station carries all three on messages and reactions, and
 * that the display name is left absent when the author has no global_name.
 */

import { describe, expect, test } from 'bun:test';
import type { Message, MessageReaction, User } from 'discord.js';
import { messageEnvelope, reactionEnvelope } from '../src/format.ts';

const emptyCollection = { map: () => [], values: () => [].values() };

const fakeMessage = (author: Record<string, unknown>): Message =>
  ({
    author: { bot: false, id: '999', ...author },
    attachments: emptyCollection,
    stickers: emptyCollection,
    content: 'hello',
    channelId: 'chan1',
    channel: { name: 'general' },
    createdTimestamp: 1_700_000_000_000,
    guildId: 'guild1',
    reference: null,
    toJSON: () => ({}),
  }) as unknown as Message;

describe('discord messageEnvelope sender identity', () => {
  test('carries the id, username handle, and global_name display name', () => {
    const env = messageEnvelope(
      'd0',
      fakeMessage({ username: 'bonustrack_', globalName: 'less' }),
    );
    expect(env).not.toBeNull();
    expect(env?.from).toBe('metro://discord/d0/user/999');
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

describe('discord reactionEnvelope sender identity', () => {
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
