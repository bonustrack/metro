import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

function journal(): JournalEntry[] {
  const raw = JSON.parse(
    readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] };
  return raw.entries;
}

describe('the migrations the release command applies', () => {
  test('every journal entry has its .sql file', () => {
    const entries = journal();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries)
      expect(existsSync(join(DIR, `${entry.tag}.sql`))).toBe(true);
  });

  test('entries are contiguous and ordered — drizzle applies by `when`', () => {
    const entries = journal();
    entries.forEach((entry, i) => {
      expect(entry.idx).toBe(i);
      if (i > 0) expect(entry.when).toBeGreaterThan(entries[i - 1]?.when ?? 0);
    });
  });

  test('every .sql on disk is named by the journal — an orphan would never run', () => {
    const tags = new Set(journal().map((e) => e.tag));
    const onDisk = readdirSync(DIR).filter((f) => f.endsWith('.sql'));
    expect(onDisk.length).toBe(tags.size);
    for (const file of onDisk)
      expect(tags.has(file.replace(/\.sql$/, ''))).toBe(true);
  });

  test('0010 creates the connectors table', () => {
    const tag = journal().at(-1)?.tag ?? '';
    expect(tag).toBe('0010_connectors');
    expect(readFileSync(join(DIR, `${tag}.sql`), 'utf8')).toContain(
      'CREATE TABLE "connectors"',
    );
  });
});
