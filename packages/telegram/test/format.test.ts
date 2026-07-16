/**
 * Sender identity on inbound telegram envelopes. The relay surfaces the id-based
 * `from` (source of truth) alongside the handle (`from_name` = @username, else
 * first_name) and the display name (`from_display_name` = first_name). Here we
 * lock that the telegram station carries both on messages and reactions.
 */

import { describe, expect, test } from 'bun:test';
import { envelope, reactionEnvelope } from '../src/format.ts';
import type { TgMsg, TgReaction } from '../src/types.ts';

const baseMsg = (over: Partial<TgMsg['from']> = {}): TgMsg => ({
  message_id: 7,
  date: 1_700_000_000,
  chat: { id: -100123, type: 'supergroup', title: 'Devs' },
  from: { id: 555, username: 'alice', first_name: 'Alice', ...over },
  text: 'hi',
});

describe('telegram envelope sender identity', () => {
  test('handle prefers @username, display name is first_name', () => {
    const env = envelope('t0', baseMsg());
    expect(env.from).toBe('metro://telegram/t0/user/555');
    expect(env.from_name).toBe('@alice');
    expect(env.from_display_name).toBe('Alice');
  });

  test('handle falls back to first_name when no username', () => {
    const env = envelope('t0', baseMsg({ username: undefined, first_name: 'Bob' }));
    expect(env.from_name).toBe('Bob');
    expect(env.from_display_name).toBe('Bob');
  });
});

describe('telegram reactionEnvelope sender identity', () => {
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
