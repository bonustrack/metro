import { describe, expect, test } from 'bun:test';
import { normalizeWhatsApp } from '../src/normalize.ts';

describe('normalizeWhatsApp', () => {
  test('reply maps to send with replyTo', () => {
    const out = normalizeWhatsApp('reply', {
      line: 'metro://whatsapp/w0/111@s.whatsapp.net',
      text: 'hi',
      messageId: 'ABC',
    });
    expect(out.action).toBe('send');
    expect(out.args.replyTo).toBe('ABC');
    expect(out.args.text).toBe('hi');
  });

  test('reply prefers explicit replyTo over messageId', () => {
    const out = normalizeWhatsApp('reply', {
      line: 'l',
      text: 'hi',
      replyTo: 'XYZ',
      messageId: 'ABC',
    });
    expect(out.args.replyTo).toBe('XYZ');
  });

  test('unreact maps to react with empty emoji', () => {
    const out = normalizeWhatsApp('unreact', { line: 'l', messageId: '7' });
    expect(out.action).toBe('react');
    expect(out.args.emoji).toBe('');
    expect(out.args.messageId).toBe('7');
  });

  test('send passes through unchanged', () => {
    const out = normalizeWhatsApp('send', { line: 'l', text: 't' });
    expect(out).toEqual({ action: 'send', args: { line: 'l', text: 't' } });
  });
});
