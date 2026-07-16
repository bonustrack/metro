import { describe, expect, test } from 'bun:test';
import type { Message } from '@mtcute/bun';
import { clampLimit, shapeHistory } from '../src/history.js';

interface FakeMessage {
  id: number;
  date: Date;
  text: string;
  sender: { id: number };
  media: { type: string } | null;
}

const asMessage = (m: FakeMessage): Message => m as unknown as Message;

const msg = (over: Partial<FakeMessage> = {}): FakeMessage => ({
  id: 1,
  date: new Date('2026-06-21T00:00:00.000Z'),
  text: 'hi',
  sender: { id: 111 },
  media: null,
  ...over,
});

describe('clampLimit', () => {
  test('defaults when missing', () => {
    expect(clampLimit(undefined)).toBe(20);
  });
  test('caps at 100', () => {
    expect(clampLimit(500)).toBe(100);
  });
  test('floors at 1', () => {
    expect(clampLimit(0)).toBe(1);
  });
});

describe('shapeHistory', () => {
  test('maps getHistory result to the xmtp/discord read shape', () => {
    const page = [
      asMessage(msg({ id: 9, text: 'newest', sender: { id: 222 } })),
      asMessage(msg({ id: 8, text: 'older' })),
    ];
    const out = shapeHistory('default', -100, page);
    expect(out.line).toBe('metro://telegram-user/default/-100');
    expect(out.count).toBe(2);
    expect(out.messages).toEqual([
      {
        id: '8',
        ts: '2026-06-21T00:00:00.000Z',
        from: 'metro://telegram-user/default/user/111',
        text: 'older',
      },
      {
        id: '9',
        ts: '2026-06-21T00:00:00.000Z',
        from: 'metro://telegram-user/default/user/222',
        text: 'newest',
      },
    ]);
  });

  test('includes from_name and from_display_name alongside the id-based from', () => {
    const named = {
      id: 7,
      date: new Date('2026-06-21T00:00:00.000Z'),
      text: 'hi',
      sender: { type: 'user', id: 333, username: 'alice', firstName: 'Alice' },
      media: null,
    };
    const out = shapeHistory('default', 5, [named as unknown as Message]);
    expect(out.messages[0]?.from).toBe('metro://telegram-user/default/user/333');
    expect(out.messages[0]?.from_name).toBe('@alice');
    expect(out.messages[0]?.from_display_name).toBe('Alice');
  });

  test('media-only message projects a media tag', () => {
    const out = shapeHistory('default', 5, [
      asMessage(msg({ id: 3, text: '', media: { type: 'photo' } })),
    ]);
    expect(out.messages[0]?.text).toBe('[photo]');
  });
});
