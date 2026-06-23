import { describe, expect, test } from 'bun:test';
import { normalizeTelegramUser } from '../src/normalize.ts';

describe('normalizeTelegramUser', () => {
  test('reply maps to send with replyTo', () => {
    const out = normalizeTelegramUser('reply', {
      line: 'metro://telegram-user/default/123',
      text: 'hi',
      replyTo: '42',
    });
    expect(out.action).toBe('send');
    expect(out.args.replyTo).toBe('42');
    expect(out.args.text).toBe('hi');
    expect(out.args.line).toBe('metro://telegram-user/default/123');
  });

  test('unreact maps to react with empty emoji', () => {
    const out = normalizeTelegramUser('unreact', {
      line: 'metro://telegram-user/default/123',
      messageId: '7',
    });
    expect(out.action).toBe('react');
    expect(out.args.emoji).toBe('');
    expect(out.args.messageId).toBe('7');
  });

  test('send passes through unchanged', () => {
    const out = normalizeTelegramUser('send', { line: 'l', text: 't' });
    expect(out.action).toBe('send');
    expect(out.args).toEqual({ line: 'l', text: 't' });
  });

  test('react passes through unchanged', () => {
    const out = normalizeTelegramUser('react', {
      line: 'l',
      messageId: '1',
      emoji: '👍',
    });
    expect(out.action).toBe('react');
    expect(out.args.emoji).toBe('👍');
  });
});
