import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachMaxBytes, attachTtlMs, sweepAttachments } from '../src/files/attach-reaper.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);
let dir = '';

function put(name: string, ageMs: number, bytes = 10): void {
  const path = join(dir, name);
  writeFileSync(path, Buffer.alloc(bytes));
  const at = (NOW - ageMs) / 1000;
  utimesSync(path, at, at);
}

const left = (): string[] => readdirSync(dir).sort();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-attach-reaper-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('sweepAttachments', () => {
  test('removes old files with their sidecars, orphans and stale parts, nothing else', () => {
    put('msg_old_0.jpg', 8 * DAY);
    put('msg_old_0.jpg.owner', 8 * DAY);
    put('msg_old_0.jpg.grant', 8 * DAY);
    put('msg_new_0.png', DAY);
    put('msg_new_0.png.owner', DAY);
    put('msg_new_0.png.grant', DAY);
    put('msg_gone_1.pdf.owner', DAY);
    put('msg_gone_1.pdf.grant', 9 * DAY);
    put('msg_torn_0.mp4.part', 2 * 60 * 60 * 1000);
    put('msg_live_0.mp4.part', 60 * 1000);
    put('msg_live_0.mp4.owner', 60 * 1000);
    put('notes.txt', 30 * DAY);
    put('msg_bad name_0.jpg', 30 * DAY);
    put('msg_x_0.toolong', 30 * DAY);
    const result = sweepAttachments({ dir, now: NOW, ttlMs: 7 * DAY, maxBytes: 1024 * 1024 });
    expect(left()).toEqual([
      'msg_bad name_0.jpg',
      'msg_live_0.mp4.owner',
      'msg_live_0.mp4.part',
      'msg_new_0.png',
      'msg_new_0.png.grant',
      'msg_new_0.png.owner',
      'msg_x_0.toolong',
      'notes.txt',
    ]);
    expect(result).toEqual({ expired: 1, capped: 0, orphans: 2, parts: 1, freedBytes: 20 });
  });

  test('caps the directory by size, oldest first', () => {
    put('msg_a_0.bin', 5 * DAY, 400);
    put('msg_a_0.bin.owner', 5 * DAY);
    put('msg_b_0.bin', 3 * DAY, 400);
    put('msg_c_0.bin', DAY, 400);
    put('msg_d_0.bin', 60 * 1000, 400);
    const result = sweepAttachments({ dir, now: NOW, ttlMs: 7 * DAY, maxBytes: 1000 });
    expect(left()).toEqual(['msg_c_0.bin', 'msg_d_0.bin']);
    expect(result.capped).toBe(2);
    expect(result.freedBytes).toBe(800);
  });

  test('a missing directory is an empty sweep', () => {
    const result = sweepAttachments({ dir: join(dir, 'absent'), now: NOW });
    expect(result).toEqual({ expired: 0, capped: 0, orphans: 0, parts: 0, freedBytes: 0 });
  });
});

describe('the limits from the environment', () => {
  const prevTtl = process.env.METRO_ATTACH_TTL_DAYS;
  const prevMax = process.env.METRO_ATTACH_MAX_MB;

  afterEach(() => {
    if (prevTtl === undefined) delete process.env.METRO_ATTACH_TTL_DAYS;
    else process.env.METRO_ATTACH_TTL_DAYS = prevTtl;
    if (prevMax === undefined) delete process.env.METRO_ATTACH_MAX_MB;
    else process.env.METRO_ATTACH_MAX_MB = prevMax;
  });

  test('a zero or bad value falls back to the default, never to zero', () => {
    for (const bad of ['0', '-3', 'soon', '']) {
      process.env.METRO_ATTACH_TTL_DAYS = bad;
      process.env.METRO_ATTACH_MAX_MB = bad;
      expect(attachTtlMs()).toBe(7 * DAY);
      expect(attachMaxBytes()).toBe(2048 * 1024 * 1024);
    }
  });

  test('a valid value is used', () => {
    process.env.METRO_ATTACH_TTL_DAYS = '30';
    process.env.METRO_ATTACH_MAX_MB = '512';
    expect(attachTtlMs()).toBe(30 * DAY);
    expect(attachMaxBytes()).toBe(512 * 1024 * 1024);
  });
});
