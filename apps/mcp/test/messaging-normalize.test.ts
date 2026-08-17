import { describe, expect, test } from 'bun:test';
import { normalizeDiscord } from '../src/stations/messaging-normalize.ts';

describe('normalizeDiscord', () => {
  test('unreact keeps the emoji and asks for a removal', () => {
    const out = normalizeDiscord('unreact', {
      line: 'metro://discord/d0/123',
      messageId: '456',
      emoji: '👀',
    });
    expect(out.action).toBe('react');
    expect(out.args.emoji).toBe('👀');
    expect(out.args.remove).toBe(true);
    expect(out.args.messageId).toBe('456');
  });

  test('react is passed through with no removal flag', () => {
    const out = normalizeDiscord('react', {
      line: 'metro://discord/d0/123',
      messageId: '456',
      emoji: '👀',
    });
    expect(out.action).toBe('react');
    expect(out.args.emoji).toBe('👀');
    expect(out.args.remove).toBeUndefined();
  });
});
