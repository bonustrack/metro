import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  MAX_INLINE_BYTES,
  decodedLengthOf,
  safeFileName,
} from '../src/stations/attach-inline.ts';
import {
  cleanupAttachments,
  resolveAttachments,
} from '../src/stations/attach-resolve.ts';
import {
  attachDir,
  resolveCachedAttachment,
} from '../src/stations/attachments.ts';

const realTmp = process.env.TMPDIR;
const sandbox = mkdtempSync(join(tmpdir(), 'metro-inline-sandbox-'));

beforeAll(() => {
  process.env.TMPDIR = sandbox;
});
afterAll(() => {
  if (realTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = realTmp;
  rmSync(sandbox, { recursive: true, force: true });
});

const leftBehind = (): string[] => readdirSync(sandbox);

const PAYLOAD = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x7f, 0x80,
]);
const B64 = PAYLOAD.toString('base64');

const b64OfDecoded = (n: number): string => {
  const quanta = Math.ceil(n / 3);
  const rem = n % 3;
  const pad = rem === 0 ? 0 : 3 - rem;
  return 'A'.repeat(quanta * 4 - pad) + '='.repeat(pad);
};

describe('inline base64 attachments', () => {
  test('land byte-identical in a 0600 temp file outside the attachment cache', async () => {
    const [a] = await resolveAttachments([
      { data: B64, name: 'shot.png', mime: 'image/png' },
    ]);
    expect(a).toBeDefined();
    if (!a) return;
    expect(Buffer.compare(readFileSync(a.path), PAYLOAD)).toBe(0);
    expect(a.bytes).toBe(PAYLOAD.length);
    expect(a.mime).toBe('image/png');
    expect(a.name).toBe('shot.png');
    expect(a.temp).toBe(dirname(a.path));
    expect(a.path.startsWith(sandbox)).toBe(true);
    expect(a.path.startsWith(attachDir())).toBe(false);
    expect(statSync(a.path).mode & 0o777).toBe(0o600);
    expect(statSync(a.temp ?? '').mode & 0o777).toBe(0o700);
    await cleanupAttachments([a]);
  });

  test('cleanup removes the file and its temp directory', async () => {
    const atts = await resolveAttachments([{ data: B64, name: 'a.bin' }]);
    expect(leftBehind()).toHaveLength(1);
    await cleanupAttachments(atts);
    expect(leftBehind()).toHaveLength(0);
  });

  test('cleanup is idempotent', async () => {
    const atts = await resolveAttachments([{ data: B64, name: 'a.bin' }]);
    await cleanupAttachments(atts);
    await cleanupAttachments(atts);
    expect(leftBehind()).toHaveLength(0);
  });

  test('the mime is guessed from the name when omitted', async () => {
    const atts = await resolveAttachments([{ data: B64, name: 'doc.pdf' }]);
    expect(atts[0]?.mime).toBe('application/pdf');
    await cleanupAttachments(atts);
  });

  test('a data: url prefix is accepted and names the mime', async () => {
    const atts = await resolveAttachments([
      { data: `data:image/png;base64,${B64}`, name: 'a.png' },
    ]);
    const a = atts[0];
    expect(a).toBeDefined();
    if (!a) return;
    expect(Buffer.compare(readFileSync(a.path), PAYLOAD)).toBe(0);
    expect(a.mime).toBe('image/png');
    await cleanupAttachments(atts);
    expect(leftBehind()).toHaveLength(0);
  });

  test('an explicit mime still wins over the one in the data: url', async () => {
    const atts = await resolveAttachments([
      { data: `data:application/octet-stream;base64,${B64}`, name: 'a.png', mime: 'image/png' },
    ]);
    expect(atts[0]?.mime).toBe('image/png');
    await cleanupAttachments(atts);
  });

  test('a data: url survives the whitespace a client may wrap it in', async () => {
    const wrapped = `data:image/png;base64,\n${B64.slice(0, 4)}\n  ${B64.slice(4)}`;
    const atts = await resolveAttachments([{ data: wrapped, name: 'a.png' }]);
    const a = atts[0];
    expect(a).toBeDefined();
    if (!a) return;
    expect(Buffer.compare(readFileSync(a.path), PAYLOAD)).toBe(0);
    expect(a.mime).toBe('image/png');
    await cleanupAttachments(atts);
    expect(leftBehind()).toHaveLength(0);
  });

  test('whitespace-wrapped and url-safe base64 both decode', async () => {
    const wrapped = `${B64.slice(0, 4)}\n  ${B64.slice(4)}`;
    const atts = await resolveAttachments([
      { data: wrapped, name: 'a.bin' },
      { data: B64.replace(/\+/g, '-').replace(/\//g, '_'), name: 'b.bin' },
    ]);
    for (const a of atts)
      expect(Buffer.compare(readFileSync(a.path), PAYLOAD)).toBe(0);
    await cleanupAttachments(atts);
  });
});

describe('the inline size ceiling', () => {
  test('one attachment over the cap is refused with the limit named', async () => {
    const over = b64OfDecoded(MAX_INLINE_BYTES + 1);
    expect(decodedLengthOf(over)).toBe(MAX_INLINE_BYTES + 1);
    await expect(
      resolveAttachments([{ data: over, name: 'huge.bin' }]),
    ).rejects.toThrow(
      new RegExp(`capped at .*\\(${MAX_INLINE_BYTES} bytes\\)`),
    );
    expect(leftBehind()).toHaveLength(0);
  });

  test('the refusal names the offending attachment and its size', async () => {
    const over = b64OfDecoded(MAX_INLINE_BYTES * 2);
    await expect(
      resolveAttachments([{ data: over, name: 'huge.bin' }]),
    ).rejects.toThrow(/inline attachment 'huge.bin' is 16\.00 MiB/);
  });

  test('the size check runs before the charset scan, so junk is not scanned first', async () => {
    const over = `${'!'.repeat(16)}${b64OfDecoded(MAX_INLINE_BYTES + 1)}`;
    await expect(
      resolveAttachments([{ data: over, name: 'huge.bin' }]),
    ).rejects.toThrow(/capped at/);
    await expect(
      resolveAttachments([{ data: over, name: 'huge.bin' }]),
    ).rejects.not.toThrow(/is not base64/);
  });

  test('a size at exactly the cap is accepted', async () => {
    const exact = b64OfDecoded(MAX_INLINE_BYTES);
    expect(decodedLengthOf(exact)).toBe(MAX_INLINE_BYTES);
    const atts = await resolveAttachments([{ data: exact, name: 'edge.bin' }]);
    expect(atts[0]?.bytes).toBe(MAX_INLINE_BYTES);
    await cleanupAttachments(atts);
    expect(leftBehind()).toHaveLength(0);
  });

  test('several attachments under the cap but over it in total are refused', async () => {
    const half = b64OfDecoded(MAX_INLINE_BYTES / 2);
    await expect(
      resolveAttachments([
        { data: half, name: 'a.bin' },
        { data: half, name: 'b.bin' },
        { data: half, name: 'c.bin' },
      ]),
    ).rejects.toThrow(/inline attachments total .* in one send/);
    expect(leftBehind()).toHaveLength(0);
  });
});

describe('malformed inline content', () => {
  test('non-base64 characters are refused rather than silently dropped', async () => {
    await expect(
      resolveAttachments([{ data: 'not base64 at all!!', name: 'a.bin' }]),
    ).rejects.toThrow(/is not base64/);
  });

  test('a data: url whose payload is not base64 is refused', async () => {
    await expect(
      resolveAttachments([{ data: 'data:text/plain,hello', name: 'a.txt' }]),
    ).rejects.toThrow(/`data:` url whose payload is not base64/);
    await expect(
      resolveAttachments([{ data: `data:,${B64}`, name: 'a.bin' }]),
    ).rejects.toThrow(/`data:` url whose payload is not base64/);
    expect(leftBehind()).toHaveLength(0);
  });

  test('a truncated quantum is refused', async () => {
    await cleanupAttachments(
      await resolveAttachments([{ data: 'QUJDRA', name: 'a.bin' }]),
    );
    await cleanupAttachments(
      await resolveAttachments([{ data: 'QUJ=', name: 'a.bin' }]),
    );
    await expect(
      resolveAttachments([{ data: 'QUJDR', name: 'a.bin' }]),
    ).rejects.toThrow(/whole number of base64 quanta/);
    await expect(
      resolveAttachments([{ data: 'QUJDRA=', name: 'a.bin' }]),
    ).rejects.toThrow(/whole number of base64 quanta/);
    expect(leftBehind()).toHaveLength(0);
  });

  test('whitespace-only content is refused as empty, not written as zero bytes', async () => {
    await expect(
      resolveAttachments([{ data: '   \n ', name: 'a.bin' }]),
    ).rejects.toThrow(/inline `data` is empty/);
    expect(leftBehind()).toHaveLength(0);
  });

  test('an empty-string source counts as no source at all', async () => {
    await expect(
      resolveAttachments([{ data: '', name: 'a.bin' }]),
    ).rejects.toThrow(/requires exactly one of `upload`, `data`, `url` or `path`/);
  });
});

describe('exactly one source', () => {
  test('path plus data is refused', async () => {
    await expect(
      resolveAttachments([{ path: '/tmp/a.png', data: B64 }]),
    ).rejects.toThrow(/names 2 sources \(`path`, `data`\)/);
  });

  test('url plus data is refused', async () => {
    await expect(
      resolveAttachments([{ url: 'https://x.test/a.png', data: B64 }]),
    ).rejects.toThrow(/names 2 sources \(`url`, `data`\)/);
  });

  test('path plus url is refused', async () => {
    await expect(
      resolveAttachments([{ path: '/tmp/a.png', url: 'https://x.test/a.png' }]),
    ).rejects.toThrow(/pass exactly one of `upload`, `data`, `url` or `path`/);
  });

  test('all three is refused', async () => {
    await expect(
      resolveAttachments([
        { path: '/tmp/a.png', url: 'https://x.test/a.png', data: B64 },
      ]),
    ).rejects.toThrow(/names 3 sources/);
  });

  test('no source at all is still refused, naming all four sources', async () => {
    await expect(resolveAttachments([{ name: 'a.png' }])).rejects.toThrow(
      /requires exactly one of `upload`, `data`, `url` or `path`/,
    );
  });

  test('a rejected multi-source attachment leaves nothing behind', async () => {
    await expect(
      resolveAttachments([{ path: '/tmp/a.png', data: B64 }]),
    ).rejects.toThrow();
    expect(leftBehind()).toHaveLength(0);
  });
});

describe('cleanup on the resolve failure path', () => {
  test('an inline attachment already written is removed when a later one fails', async () => {
    await expect(
      resolveAttachments([
        { data: B64, name: 'good.bin' },
        { path: join(sandbox, 'definitely-missing.png') },
      ]),
    ).rejects.toThrow(/attachment 2 of 2: .*does not exist on the metro host/);
    expect(leftBehind()).toHaveLength(0);
  });

  test('every inline attachment before the failure is removed', async () => {
    await expect(
      resolveAttachments([
        { data: B64, name: 'a.bin' },
        { data: B64, name: 'b.bin' },
        { data: 'nope!!', name: 'c.bin' },
      ]),
    ).rejects.toThrow(/attachment 3 of 3/);
    expect(leftBehind()).toHaveLength(0);
  });
});

describe('temp filenames are derived safely from a caller-supplied name', () => {
  test('path separators and traversal cannot escape the temp directory', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('/etc/shadow')).toBe('shadow');
    expect(safeFileName('..')).toBe('attachment');
    expect(safeFileName('.ssh')).toBe('ssh');
    expect(safeFileName(undefined)).toBe('attachment');
    expect(safeFileName('')).toBe('attachment');
    expect(safeFileName('a b;rm -rf .png')).toBe('a_b_rm_-rf_.png');
  });

  test('a cache-shaped name cannot make the temp file servable by /attach', async () => {
    const atts = await resolveAttachments([
      { data: B64, name: 'msg_abcd1234_0.png' },
    ]);
    const a = atts[0];
    expect(a).toBeDefined();
    if (!a) return;
    expect(a.path.startsWith(attachDir())).toBe(false);
    expect(resolveCachedAttachment('msg_abcd1234_0.png')).toBe(
      join(attachDir(), 'msg_abcd1234_0.png'),
    );
    expect(resolveCachedAttachment('msg_abcd1234_0.png')).not.toBe(a.path);
    await cleanupAttachments(atts);
    expect(leftBehind()).toHaveLength(0);
  });

  test('the written file stays inside its own temp directory', async () => {
    const atts = await resolveAttachments([
      { data: B64, name: '../../../escape.png' },
    ]);
    const a = atts[0];
    expect(a).toBeDefined();
    if (!a) return;
    expect(dirname(a.path)).toBe(a.temp);
    expect(a.name).toBe('../../../escape.png');
    await cleanupAttachments(atts);
    expect(leftBehind()).toHaveLength(0);
  });
});
