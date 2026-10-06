import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveBufferToCache } from '@metro-labs/core/stations/attachments';

const prev = process.env.METRO_XMTP_ATTACH_DIR;
let dir = '';
const meta = { mime: 'application/zip', name: 'fixture.zip' };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'metro-buffer-save-'));
  process.env.METRO_XMTP_ATTACH_DIR = dir;
});

afterEach(async () => {
  if (prev === undefined) delete process.env.METRO_XMTP_ATTACH_DIR;
  else process.env.METRO_XMTP_ATTACH_DIR = prev;
  await rm(dir, { recursive: true, force: true });
});

describe('saveBufferToCache', () => {
  test('replacing a file preserves bytes for an already open download', async () => {
    const previous = Buffer.from('previous complete attachment');
    const next = Buffer.from('next complete attachment');
    const saved = await saveBufferToCache(previous, 'repeat1', 0, meta);
    const reader = await open(saved.path, 'r');
    try {
      const replaced = await saveBufferToCache(next, 'repeat1', 0, meta);
      expect(replaced).toEqual({ ...saved, bytes: next.length });
      expect(await reader.readFile()).toEqual(previous);
      expect(await readFile(saved.path)).toEqual(next);
      expect(await readdir(dir)).toEqual(['msg_repeat1_0.zip']);
    } finally {
      await reader.close();
    }
  });

  test('simultaneous saves publish a whole file without sharing a partial path', async () => {
    const first = Buffer.alloc(2 * 1024 * 1024, 1);
    const second = Buffer.alloc(3 * 1024 * 1024, 2);
    const saved = await Promise.all([
      saveBufferToCache(first, 'parallel1', 0, meta),
      saveBufferToCache(second, 'parallel1', 0, meta),
    ]);
    expect(saved[0]!.path).toBe(saved[1]!.path);
    const bytes = await readFile(saved[0]!.path);
    expect(bytes.equals(first) || bytes.equals(second)).toBe(true);
    expect(await readdir(dir)).toEqual(['msg_parallel1_0.zip']);
  });

  test('a failed replacement cleans its partial file without removing the target', async () => {
    const target = join(dir, 'msg_blocked1_0.zip');
    await mkdir(target);
    await expect(saveBufferToCache(Buffer.from('fixture'), 'blocked1', 0, meta)).rejects.toThrow();
    expect(await readdir(dir)).toEqual(['msg_blocked1_0.zip']);
    expect(await readdir(target)).toEqual([]);
  });
});
