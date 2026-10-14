import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { announcedLine, forgetAnnounced, noteAnnounced, setAnnouncedFile } from '../src/mcp-server/announced.ts';

const LINE = 'metro://telegram-bot/tb000000001/-100777';
const DAY = 24 * 3_600_000;
let dir = '';
let file = '';

const LETTERS = 'abcdefghijkmnopqrstuvwxyz';
const ids = (count: number): string[] => Array.from({ length: count }, (_, i) => `${LETTERS[i % 25] ?? ''}${LETTERS[Math.floor(i / 25)] ?? ''}npq`);
const saved = (): Record<string, unknown> => (JSON.parse(readFileSync(file, 'utf8')) as { announced: Record<string, unknown> }).announced;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-announced-'));
  file = join(dir, 'mcp-approvals.json');
});

afterEach(() => {
  forgetAnnounced();
  rmSync(dir, { recursive: true, force: true });
});

describe('the approvals already announced in chat', () => {
  test('are read back after a restart, and only for a day', () => {
    const now = 1_800_000_000_000;
    setAnnouncedFile(file, now);
    noteAnnounced('abcde', LINE, now);
    forgetAnnounced();
    setAnnouncedFile(file, now + 1_000);
    expect(announcedLine('abcde', now + 1_000)).toBe(LINE);
    expect(announcedLine('abcde', now + DAY)).toBeUndefined();
    expect(announcedLine('bcdef', now + 1_000)).toBeUndefined();
  });

  test('keep the newest 200 and drop entries older than a day at the next write', () => {
    const now = 1_800_000_000_000;
    setAnnouncedFile(file, now);
    noteAnnounced('zzzzz', LINE, now - DAY);
    const all = ids(210);
    expect(new Set(all).size).toBe(210);
    all.forEach((id, i) => {
      noteAnnounced(id, LINE, now + i);
    });
    const kept = Object.keys(saved());
    expect(kept).toHaveLength(200);
    expect(kept).not.toContain('zzzzz');
    expect(kept).not.toContain(all[0]);
    expect(kept).toContain(all[209]);
  });

  test('a broken or foreign file is ignored, never trusted', () => {
    writeFileSync(file, '{not json');
    setAnnouncedFile(file);
    expect(announcedLine('abcde')).toBeUndefined();
    writeFileSync(file, JSON.stringify({ version: 1, announced: { abcde: { line: 'https://evil.example', at: Date.now() }, 'not-an-id': { line: LINE, at: Date.now() }, bcdef: { line: LINE, at: Date.now() + DAY } } }));
    forgetAnnounced();
    setAnnouncedFile(file);
    expect(announcedLine('abcde')).toBeUndefined();
    expect(announcedLine('not-an-id')).toBeUndefined();
    expect(announcedLine('bcdef')).toBeUndefined();
  });

  test('without a file they live in memory only', () => {
    noteAnnounced('abcde', LINE);
    expect(announcedLine('abcde')).toBe(LINE);
    expect(existsSync(file)).toBe(false);
  });
});
