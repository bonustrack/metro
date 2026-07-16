/**
 * Sender display names on inbound discord envelopes. The relay surfaces
 * `from_name` additively next to the id-based `from`; here we lock that the
 * discord station sets it (author/user username) on both messages and
 * reactions, so the name is carried generically, not just for telegram.
 */

import { describe, expect, test } from 'bun:test';
import type { Message, MessageReaction, User } from 'discord.js';
import { messageEnvelope, reactionEnvelope } from '../src/format.ts';

const emptyCollection = { map: () => [], values: () => [].values() };

const fakeMessage = (): Message =>
  ({
    author: { bot: false, id: '999', username: 'coolcat' },
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

describe('discord messageEnvelope from_name', () => {
  test('carries the author username', () => {
    const env = messageEnvelope('d0', fakeMessage());
    expect(env).not.toBeNull();
    expect(env?.from).toBe('metro://discord/d0/user/999');
    expect(env?.from_name).toBe('coolcat');
  });
});

describe('discord reactionEnvelope from_name', () => {
  test('carries the reactor username', () => {
    const u = { bot: false, id: '999', username: 'coolcat' } as unknown as User;
    const r = {
      message: { channelId: 'chan1', id: 'm1', guildId: 'guild1' },
      emoji: { name: '👍', id: null, toJSON: () => ({}) },
    } as unknown as MessageReaction;
    const env = reactionEnvelope('d0', r, u);
    expect(env).not.toBeNull();
    expect(env?.from_name).toBe('coolcat');
  });
});
