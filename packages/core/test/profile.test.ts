import { describe, expect, test } from 'bun:test';
import { assertImage, fieldsOf, parseProfileChange } from '../src/stations/profile.ts';

describe('parseProfileChange', () => {
  test('keeps the fields given, trimmed, and names them in order', () => {
    const change = parseProfileChange({ name: '  Lisa ', avatar: { path: '/tmp/a.png', mime: 'image/png' } });
    expect(change).toEqual({ name: 'Lisa', avatar: { path: '/tmp/a.png', mime: 'image/png', name: 'avatar' } });
    expect(fieldsOf(change)).toEqual(['name', 'avatar']);
    expect(fieldsOf(parseProfileChange({ bio: 'x' }))).toEqual(['bio']);
  });

  test('refuses an empty change, a blank or over-long field, a non-string, and an avatar without a file', () => {
    expect(() => parseProfileChange({})).toThrow('at least one of');
    expect(() => parseProfileChange({ name: '   ' })).toThrow('name cannot be empty');
    expect(() => parseProfileChange({ name: 'x'.repeat(65) })).toThrow('over 64');
    expect(() => parseProfileChange({ bio: 'x'.repeat(513) })).toThrow('over 512');
    expect(() => parseProfileChange({ bio: 12 })).toThrow('bio must be a string');
    expect(() => parseProfileChange({ avatar: { mime: 'image/png' } })).toThrow('avatar needs a local file');
  });

  test('assertImage refuses anything but an image', () => {
    expect(() => assertImage({ path: '/tmp/a', mime: 'application/pdf', name: 'a' })).toThrow('must be an image');
    expect(() => assertImage({ path: '/tmp/a', mime: 'image/webp', name: 'a' })).not.toThrow();
  });
});
