import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kindOf, toCanonical } from '../src/stations/attachments.ts';
import { resolveAttachments } from '../src/stations/attach-resolve.ts';

const dir = mkdtempSync(join(tmpdir(), 'metro-att-'));
const png = join(dir, 'a.png');
writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

describe('resolveAttachments', () => {
  test('a local path resolves to itself with a guessed mime and name', async () => {
    const [a] = await resolveAttachments([{ path: png }]);
    expect(a?.path).toBe(png);
    expect(a?.mime).toBe('image/png');
    expect(a?.name).toBe('a.png');
    expect(a?.bytes).toBe(4);
  });

  test('a missing path fails loudly and says paths are read on the daemon', async () => {
    const missing = join(dir, 'nope.png');
    await expect(resolveAttachments([{ path: missing }])).rejects.toThrow(
      /does not exist on the metro host/,
    );
  });

  test('the error names which attachment of how many failed', async () => {
    await expect(
      resolveAttachments([{ path: png }, { path: join(dir, 'nope.png') }]),
    ).rejects.toThrow(/attachment 2 of 2/);
  });

  test('a non-http url is refused rather than treated as a path', async () => {
    await expect(
      resolveAttachments([{ url: 'ftp://example.com/a.png' }]),
    ).rejects.toThrow(/not an http\(s\) url/);
  });

  test('an attachment with neither path nor url is refused', async () => {
    await expect(resolveAttachments([{ name: 'a.png' }])).rejects.toThrow(
      /requires exactly one of `upload`, `data`, `url` or `path`/,
    );
  });
});

describe('the canonical wire shape', () => {
  test('carries a real local path, never the original url', () => {
    const wire = toCanonical({
      path: '/cache/a.png',
      mime: 'image/png',
      name: 'a.png',
    });
    expect(wire.path).toBe('/cache/a.png');
    expect(wire.kind).toBe('image');
    expect(wire.mime).toBe('image/png');
  });

  test('classifies by mime so stations can pick the right send verb', () => {
    expect(kindOf('image/png', '/a.png')).toBe('image');
    expect(kindOf('video/mp4', '/a.mp4')).toBe('video');
    expect(kindOf('audio/ogg', '/a.ogg')).toBe('audio');
    expect(kindOf('application/pdf', '/a.pdf')).toBe('file');
    expect(kindOf('text/markdown', '/a.md')).toBe('file');
  });
});
