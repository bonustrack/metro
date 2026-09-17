import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { AVATAR_MAX_BYTES, AvatarError, parseAvatar } from '../src/avatar.ts';
import { pngBytes, pngDataUrl } from './png-fixture.ts';

const refused = (raw: unknown): string => {
  try {
    parseAvatar(raw);
  } catch (err) {
    if (err instanceof AvatarError) return err.message;
    throw err;
  }
  throw new Error('expected the avatar to be refused');
};

describe('an agent avatar on metro.box', () => {
  test('a small PNG data url is kept as sent, and null removes the avatar', () => {
    const png = pngDataUrl(64, 64);
    expect(parseAvatar(png)).toBe(png);
    expect(parseAvatar(pngDataUrl(256, 1))).toStartWith('data:image/png;base64,');
    expect(parseAvatar(null)).toBeNull();
  });

  test('an SVG is refused by its type and by its bytes, whatever the label says', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>fetch(1)</script></svg>');
    expect(refused(`data:image/svg+xml;base64,${svg.toString('base64')}`)).toContain('data:image/png');
    expect(refused(`data:image/png;base64,${svg.toString('base64')}`)).toBe('the avatar must be a PNG image');
    expect(refused(`data:image/svg+xml,<svg onload=alert(1)/>`)).toContain('data:image/png');
  });

  test('a JPEG, a GIF, random bytes, a PNG with a bad tail and a non-string are refused', () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
    expect(refused(`data:image/png;base64,${jpeg.toString('base64')}`)).toBe('the avatar must be a PNG image');
    expect(refused(`data:image/gif;base64,${Buffer.from('GIF89a').toString('base64')}`)).toContain('data:image/png');
    expect(refused(`data:image/png;base64,${randomBytes(200).toString('base64')}`)).toBe('the avatar must be a PNG image');
    const truncated = pngBytes(8, 8).subarray(0, -4);
    expect(refused(`data:image/png;base64,${truncated.toString('base64')}`)).toBe('the avatar must be a PNG image');
    const trailing = Buffer.concat([pngBytes(8, 8), Buffer.from('<script>')]);
    expect(refused(`data:image/png;base64,${trailing.toString('base64')}`)).toBe('the avatar must be a PNG image');
    expect(refused(undefined)).toContain('null to remove');
    expect(refused(7)).toContain('null to remove');
    expect(refused('data:image/png;base64,not base64!!')).toContain('data:image/png');
    expect(refused('data:image/png;base64,abc')).toBe('the avatar must be a PNG image');
  });

  test('the size and the pixel dimensions are capped', () => {
    expect(refused(pngDataUrl(257, 10))).toContain('256 by 256');
    expect(refused(pngDataUrl(10, 300))).toContain('256 by 256');
    const big = Buffer.concat([pngBytes(8, 8).subarray(0, -12), randomBytes(AVATAR_MAX_BYTES), pngBytes(8, 8).subarray(-12)]);
    expect(refused(`data:image/png;base64,${big.toString('base64')}`)).toContain('KiB');
  });
});
