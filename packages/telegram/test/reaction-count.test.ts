/**
 * reactionCountEnvelope: anonymous group reaction aggregates (message_reaction_count)
 * surface as the same react event shape as per-user reactions. Telegram only sends
 * message_reaction_count when the bot can't see the reactor (non-admin in a group),
 * so the envelope is anonymous (user/unknown) and picks the top emoji by total_count.
 */

import { describe, expect, test } from 'bun:test';
import { reactionCountEnvelope } from '../src/format.ts';
import type { TgReactionCount } from '../src/types.ts';

describe('reactionCountEnvelope', () => {
  test('emits react event for top emoji by total_count', () => {
    const rc: TgReactionCount = {
      chat: { id: -100123, type: 'supergroup' },
      message_id: 42,
      date: 1_700_000_000,
      reactions: [
        { type: { type: 'emoji', emoji: '👍' }, total_count: 2 },
        { type: { type: 'emoji', emoji: '🔥' }, total_count: 5 },
      ],
    };
    const env = reactionCountEnvelope('t0', rc);
    expect(env).not.toBeNull();
    expect(env).toMatchObject({
      kind: 'react',
      station: 'telegram',
      line: 'metro://telegram/t0/-100123',
      from: 'metro://telegram/t0/user/unknown',
      message_id: '42',
      emoji: '🔥',
      event: { type: 'react', emoji: '🔥', targetId: '42' },
      is_private: false,
      payload: rc,
    });
  });

  test('returns null when no emoji-type reactions', () => {
    const rc: TgReactionCount = {
      chat: { id: 123, type: 'private' },
      message_id: 7,
      date: 1_700_000_000,
      reactions: [
        { type: { type: 'custom_emoji' }, total_count: 3 },
      ],
    };
    expect(reactionCountEnvelope('t0', rc)).toBeNull();
  });

  test('returns null when reactions empty', () => {
    const rc: TgReactionCount = {
      chat: { id: 123, type: 'group' },
      message_id: 7,
      date: 1_700_000_000,
      reactions: [],
    };
    expect(reactionCountEnvelope('t0', rc)).toBeNull();
  });
});
