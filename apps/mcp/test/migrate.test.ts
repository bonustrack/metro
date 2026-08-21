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
    expect(readFileSync(join(DIR, '0010_connectors.sql'), 'utf8')).toContain(
      'CREATE TABLE "connectors"',
    );
  });

  test('0013 is the newest migration', () => {
    expect(journal().at(-1)?.tag).toBe('0013_stations_single_id');
  });

  test('0013 stashes the old handle before it drops the column', () => {
    const sql = readFileSync(join(DIR, '0013_stations_single_id.sql'), 'utf8');
    const stash = sql.indexOf("'previousAccountId'");
    const drop = sql.indexOf('DROP COLUMN "account_id"');
    expect(stash).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(stash);
  });

  test('0013 drops the unique that went with the column', () => {
    const sql = readFileSync(join(DIR, '0013_stations_single_id.sql'), 'utf8');
    expect(sql).toContain('DROP CONSTRAINT "stations_station_account_id_unique"');
  });

  test('0011 moves accounts into stations instead of dropping them', () => {
    const sql = readFileSync(join(DIR, '0011_stations_and_text_ids.sql'), 'utf8');
    expect(sql).toContain('CREATE TABLE "stations"');
    expect(sql).toContain('INSERT INTO "stations"');
    expect(sql).toContain('FROM "accounts"');
  });

  test('0011 puts id first in every table it creates', () => {
    const sql = readFileSync(join(DIR, '0011_stations_and_text_ids.sql'), 'utf8');
    const firsts = [...sql.matchAll(/CREATE TABLE "[^"]+" \(\n\t"([a-z_]+)"/g)].map((m) => m[1]);
    expect(firsts.length).toBeGreaterThan(0);
    for (const first of firsts) expect(first).toBe('id');
  });

  test('0011 refuses rather than silently dropping orphan rows', () => {
    const sql = readFileSync(join(DIR, '0011_stations_and_text_ids.sql'), 'utf8');
    expect(sql).toContain('RAISE EXCEPTION');
  });

  test('0012 pins the db3 path xmtp was only ever resolving by fallback', () => {
    const sql = readFileSync(join(DIR, '0012_pin_xmtp_dbpath.sql'), 'utf8');
    expect(sql).toContain("'~/.metro/xmtp-production-' || \"account_id\"");
    expect(sql).toContain('\'.db3\'');
  });

  test('0012 only fills a missing dbPath, so re-running cannot repoint a live inbox', () => {
    const sql = readFileSync(join(DIR, '0012_pin_xmtp_dbpath.sql'), 'utf8');
    expect(sql).toContain('"config"->>\'dbPath\' IS NULL');
    expect(sql).toContain('"station" = \'xmtp\'');
  });

  test('0011 leaves no scaffolding behind', () => {
    const sql = readFileSync(join(DIR, '0011_stations_and_text_ids.sql'), 'utf8');
    expect(sql).toContain('DROP FUNCTION metro_new_id()');
    expect(sql).not.toContain('metro_new_id text;\nALTER');
  });
});
