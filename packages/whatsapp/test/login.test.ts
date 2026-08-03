import { describe, expect, test } from 'bun:test';
import { normalizePhone, WhatsappLoginError } from '../src/login.ts';

describe('normalizePhone', () => {
  test('strips the formatting people paste', () => {
    expect(normalizePhone('+44 (770) 090-0123')).toBe('447700900123');
    expect(normalizePhone('447700900123')).toBe('447700900123');
  });

  test('a blank phone means QR mode, not an error', () => {
    expect(normalizePhone('')).toBe('');
    expect(normalizePhone(undefined)).toBe('');
    expect(normalizePhone(null)).toBe('');
    expect(normalizePhone(42)).toBe('');
  });

  test('a number that cannot be a phone is refused', () => {
    for (const phone of ['12345', '0'.repeat(20), '+44 abc'])
      expect(() => normalizePhone(phone)).toThrow(WhatsappLoginError);
  });

  test('the refusal explains the format instead of echoing the input', () => {
    try {
      normalizePhone('12345');
      throw new Error('should have been refused');
    } catch (err) {
      expect((err as Error).message).toContain('447700900123');
      expect((err as Error).message).not.toContain('12345');
    }
  });
});
