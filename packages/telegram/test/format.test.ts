/**
 * Sender display names on inbound telegram envelopes. The relay surfaces
 * `from_name` additively next to the id-based `from`; here we lock that the
 * telegram station populates it (@username, else first_name) on both messages
 * and reactions, so group-chat messages carry a human name, not just the id.
 */

import { describe, expect, test } from 'bun:test';
import { envelope, reactionEnvelope } from '../src/format.ts';
import type { TgMsg, TgReaction } from '../src/types.ts';

const baseMsg = (over: Partial<TgMsg['from']> = {}): TgMsg => ({
  message_id: 7,
  date: 1_700_000_000,
  chat: { id: -100123, type: 'supergroup', title: 'Devs' },
  from: { id: 555, username: 'alice', ...over },
  text: 'hi',
});

describe('telegram envelope from_name', () => {
  test('prefers @username', () => {
    const env = envelope('t0', baseMsg());
    expect(env.from).toBe('metro://telegram/t0/user/555');
    expect(env.from_name).toBe('@alice');
  });

  test('falls back to first_name when no username', () => {
    const env = envelope('t0', baseMsg({ username: undefined, first_name: 'Bob' }));
    expect(env.from_name).toBe('Bob');
  });
});

describe('telegram reactionEnvelope from_name', () => {
  test('carries the reactor name', () => {
    const r: TgReaction = {
      chat: { id: -100123, type: 'supergroup' },
      message_id: 42,
      user: { id: 555, username: 'alice' },
      date: 1_700_000_000,
      old_reaction: [],
      new_reaction: [{ type: 'emoji', emoji: '🔥' }],
    };
    const env = reactionEnvelope('t0', r);
    expect(env).not.toBeNull();
    expect(env?.from_name).toBe('@alice');
  });
});
