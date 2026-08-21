import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATIONS_DIR, migrateToLatest } from '../src/db/migrate.ts';

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

function journal(): { entries: JournalEntry[] } {
  return JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] };
}

describe('the migrations the release command will apply', () => {
  test('MIGRATIONS_DIR resolves off the module, not the cwd', () => {
    expect(MIGRATIONS_DIR.endsWith('/apps/mcp/drizzle')).toBe(true);
    expect(existsSync(MIGRATIONS_DIR)).toBe(true);
  });

  test('the journal is readable and every entry has its .sql file', () => {
    const entries = journal().entries;
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries)
      expect(existsSync(join(MIGRATIONS_DIR, `${entry.tag}.sql`))).toBe(true);
  });

  test('journal entries are contiguous and ordered — the migrator applies by `when`', () => {
    const entries = journal().entries;
    entries.forEach((entry, i) => {
      expect(entry.idx).toBe(i);
      if (i > 0) expect(entry.when).toBeGreaterThan(entries[i - 1]?.when ?? 0);
    });
  });

  test('every .sql on disk is named by the journal — an orphan would never run', () => {
    const tags = new Set(journal().entries.map((e) => e.tag));
    const onDisk = readdirSync(MIGRATIONS_DIR).filter((f) =>
      f.endsWith('.sql'),
    );
    expect(onDisk.length).toBe(tags.size);
    for (const file of onDisk)
      expect(tags.has(file.replace(/\.sql$/, ''))).toBe(true);
  });

  test('0010 creates the connectors table', () => {
    const tag = journal().entries.at(-1)?.tag ?? '';
    expect(tag).toBe('0010_connectors');
    const sql = readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), 'utf8');
    expect(sql).toContain('CREATE TABLE "connectors"');
  });

  test('it refuses to migrate with no DATABASE_URL rather than half-running', async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      await expect(migrateToLatest()).rejects.toThrow(/DATABASE_URL/);
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
  });
});
