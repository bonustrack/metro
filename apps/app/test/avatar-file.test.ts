import { describe, expect, test } from 'bun:test';
import { acceptsAvatar, AVATAR_ACCEPT, decodedSize } from '../src/components/avatar-file.ts';

describe('picking an avatar file', () => {
  test('only raster types are accepted; SVG and anything else are refused before any drawing', () => {
    expect(acceptsAvatar('image/png')).toBe(true);
    expect(acceptsAvatar('image/JPEG')).toBe(true);
    expect(acceptsAvatar('image/webp')).toBe(true);
    expect(acceptsAvatar('image/gif')).toBe(true);
    expect(acceptsAvatar('image/svg+xml')).toBe(false);
    expect(acceptsAvatar('text/html')).toBe(false);
    expect(acceptsAvatar('')).toBe(false);
    expect(AVATAR_ACCEPT).not.toContain('svg');
  });

  test('the decoded size of a data url counts bytes, not characters', () => {
    expect(decodedSize(`data:image/png;base64,${Buffer.alloc(300).toString('base64')}`)).toBe(300);
    expect(decodedSize(`data:image/png;base64,${Buffer.alloc(301).toString('base64')}`)).toBe(301);
    expect(decodedSize(`data:image/png;base64,${Buffer.alloc(302).toString('base64')}`)).toBe(302);
  });
});
