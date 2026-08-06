/**
 * `saveStreamToCache` is the streaming sibling of `saveBufferToCache`.
 *
 * WhatsApp carries documents up to 2 GB, and metro's own ceiling is
 * `MAX_ATTACHMENT_BYTES` (100 MiB by default). Buffering a file that size in
 * memory to hand it to `saveBufferToCache` would peak at roughly twice the file
 * on a 1 GB machine that is also holding live XMTP clients, so the bytes go
 * from the socket to a `.part` file with a running counter and are `rename`d
 * into place only on completion — the same shape `daemon/upload-store.ts` uses
 * for the outbound direction, and for the same reason.
 *
 * Two things are pinned. The running counter refuses AS the bytes arrive, so a
 * stream whose true length was never declared cannot run past the ceiling; and
 * a refused or torn save leaves NOTHING behind, neither a half file nor an
 * orphan `.part` charged to the cache forever.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  MAX_ATTACHMENT_BYTES,
  saveStreamToCache,
} from '../src/stations/attachments.ts';

const prev = process.env.METRO_XMTP_ATTACH_DIR;
let dir = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-stream-save-'));
  process.env.METRO_XMTP_ATTACH_DIR = dir;
});

afterAll(() => {
  if (prev === undefined) delete process.env.METRO_XMTP_ATTACH_DIR;
  else process.env.METRO_XMTP_ATTACH_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

const sha = (b: Uint8Array): string =>
  createHash('sha256').update(b).digest('hex');

describe('saveStreamToCache', () => {
  test('a chunked stream lands byte-identical under the cache name', async () => {
    const data = randomBytes(300_000);
    const chunks = [
      data.subarray(0, 1),
      data.subarray(1, 65_536),
      data.subarray(65_536),
    ];
    const saved = await saveStreamToCache(Readable.from(chunks), 'ABC123', 0, {
      mime: 'application/pdf',
      name: 'contract.pdf',
    });
    expect(saved.path).toBe(join(dir, 'msg_ABC123_0.pdf'));
    expect(saved.bytes).toBe(data.length);
    expect(saved.name).toBe('contract.pdf');
    expect(sha(readFileSync(saved.path))).toBe(sha(data));
  });

  test('an empty stream still produces a file rather than an error', async () => {
    const saved = await saveStreamToCache(Readable.from([]), 'EMPTY1', 0, {
      mime: 'application/pdf',
    });
    expect(saved.bytes).toBe(0);
    expect(readFileSync(saved.path).length).toBe(0);
  });

  test('the running counter refuses past the ceiling and leaves no file', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    const stream = Readable.from({
      [Symbol.asyncIterator]: async function* gen() {
        for (let i = 0; i <= MAX_ATTACHMENT_BYTES / chunk.length; i += 1)
          yield chunk;
      },
    });
    await expect(
      saveStreamToCache(stream, 'TOOBIG', 0, { mime: 'video/mp4' }),
    ).rejects.toThrow(/exceeds limit of/);
    expect(readdirSync(dir).filter((f) => f.includes('TOOBIG'))).toEqual([]);
  });

  test('a stream that errors mid-flight leaves no .part behind', async () => {
    const stream = Readable.from({
      [Symbol.asyncIterator]: async function* gen() {
        yield new Uint8Array(16);
        throw new Error('connection reset by peer');
      },
    });
    await expect(
      saveStreamToCache(stream, 'TORN01', 0, { mime: 'application/pdf' }),
    ).rejects.toThrow('connection reset by peer');
    expect(readdirSync(dir).filter((f) => f.includes('TORN01'))).toEqual([]);
  });

  test('no .part survives any of the above', () => {
    expect(readdirSync(dir).filter((f) => f.endsWith('.part'))).toEqual([]);
  });
});
