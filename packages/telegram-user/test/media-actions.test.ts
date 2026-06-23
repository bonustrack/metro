import { describe, expect, test } from 'bun:test';
import { buildInputMedia } from '../src/media-actions.js';

describe('buildInputMedia', () => {
  test('image mime → photo input media with caption + fileName', () => {
    const m = buildInputMedia(
      { url: '/cache/a.jpg', mime: 'image/jpeg', name: 'a.jpg' },
      'a caption',
    );
    expect(m.type).toBe('photo');
    expect(m.file).toBe('/cache/a.jpg');
    expect(m.caption).toBe('a caption');
    expect(m.fileName).toBe('a.jpg');
  });

  test('image kind without mime → photo', () => {
    const m = buildInputMedia({ url: '/cache/b', kind: 'image' }, undefined);
    expect(m.type).toBe('photo');
    expect(m.caption).toBeUndefined();
  });

  test('image by extension → photo', () => {
    const m = buildInputMedia({ url: '/cache/c.png' }, undefined);
    expect(m.type).toBe('photo');
  });

  test('non-image → document', () => {
    const m = buildInputMedia(
      { url: '/cache/d.pdf', mime: 'application/pdf', name: 'd.pdf' },
      undefined,
    );
    expect(m.type).toBe('document');
    expect(m.file).toBe('/cache/d.pdf');
    expect(m.fileName).toBe('d.pdf');
  });
});
