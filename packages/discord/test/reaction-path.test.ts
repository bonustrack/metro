import { describe, expect, test } from 'bun:test';
import { ownReactionPath } from '../src/accounts.ts';

describe('discord ownReactionPath', () => {
  test('names the emoji so a removal targets only our own reaction', () => {
    const path = ownReactionPath('123', '456', '👀');
    expect(path).toBe(
      '/channels/123/messages/456/reactions/%F0%9F%91%80/@me',
    );
  });

  test('falls back to the whole-message route when no emoji is given', () => {
    expect(ownReactionPath('123', '456', '')).toBe(
      '/channels/123/messages/456/reactions/@me',
    );
  });
});
