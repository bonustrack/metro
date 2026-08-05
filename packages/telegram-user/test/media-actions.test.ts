import { describe, expect, test } from 'bun:test';
import { buildInputMedia } from '../src/media-actions.js';

describe('buildInputMedia', () => {
  test('image mime → photo input media with caption + fileName', () => {
    const m = buildInputMedia(
      { path: '/cache/a.jpg', mime: 'image/jpeg', name: 'a.jpg' },
      'a caption',
    );
    expect(m.type).toBe('photo');
    expect(m.file).toBe('file:/cache/a.jpg');
    expect(m.caption).toBe('a caption');
    expect(m.fileName).toBe('a.jpg');
  });

  test('a local path is prefixed with file: so mtcute does not read it as a file id', () => {
    const m = buildInputMedia({ path: '/data/x/audit.png' }, undefined);
    expect(m.file).toBe('file:/data/x/audit.png');
  });

  test('an http url is passed through untouched for telegram to fetch', () => {
    const m = buildInputMedia(
      { url: 'https://example.com/a.png', mime: 'image/png' },
      undefined,
    );
    expect(m.file).toBe('https://example.com/a.png');
  });

  test('an already-prefixed file: path is not double-prefixed', () => {
    const m = buildInputMedia({ path: 'file:/cache/a.png' }, undefined);
    expect(m.file).toBe('file:/cache/a.png');
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
      { path: '/cache/d.pdf', mime: 'application/pdf', name: 'd.pdf' },
      undefined,
    );
    expect(m.type).toBe('document');
    expect(m.file).toBe('file:/cache/d.pdf');
    expect(m.fileName).toBe('d.pdf');
  });
});
