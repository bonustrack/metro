import { expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { accountId } from '../src/db/account-ids.ts';
import * as schema from '../src/db/schema.ts';
import { PGLITE_START_MS } from './pglite-db.ts';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
const ORG = 'org_01CHATREADS000';

function through(dir: string, last: number): void {
  cpSync(DIR, dir, { recursive: true });
  const path = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(path, 'utf8')) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx <= last);
  writeFileSync(path, JSON.stringify(journal));
}

test('0036 marks every chat seen up to now for its starter, the people added and, when shared with the organization, every member, so no old reply shows as new', async () => {
  const before = mkdtempSync(join(tmpdir(), 'metro-chat-reads-35-'));
  const after = mkdtempSync(join(tmpdir(), 'metro-chat-reads-36-'));
  const client = new PGlite();
  const db = drizzle(client, { schema });
  try {
    through(before, 35);
    through(after, 36);
    await migrate(db, { migrationsFolder: before });
    await client.query("INSERT INTO organizations (id, slug, created_at, updated_at) VALUES ($1, 'reads', 'now', 'now')", [ORG]);
    await client.query("INSERT INTO agents (id, owner, kind, host, added_at, slug) VALUES ('agent000001', $1, 'box', 'box.example', 'now', 'box')", [ORG]);
    for (const [id, by] of [['chat0000001', 'user_01ANA'], ['chat0000002', 'user_01BEN']]) await client.query("INSERT INTO chats (id, owner, agent, created_by, title, shared, created_at, updated_at) VALUES ($1, $2, 'agent000001', $3, 'x', 'private', 1, 1)", [id, ORG, by]);
    await client.query("INSERT INTO chat_members (chat, user_id, added_by, added_at) VALUES ('chat0000001', 'user_01CAL', 'user_01ANA', 1)");
    await client.query("UPDATE chats SET shared = 'organization' WHERE id = 'chat0000002'");
    for (const user of ['user_01ANA', 'user_01DAN']) {
      await client.query("INSERT INTO users (id, updated_at) VALUES ($1, 'x') ON CONFLICT DO NOTHING", [user]);
      await client.query("INSERT INTO memberships (id, organization, user_id, role, created_at, updated_at) VALUES ($1, $2, $3, 'member', 0, 0)", [accountId('om'), ORG, user]);
    }
    await client.query("INSERT INTO chat_messages (id, chat, seq, role, author, reply_to, body, at) VALUES ('msg00000001', 'chat0000001', 1, 'user', 'user_01ANA', NULL, 'x', 1), ('msg00000002', 'chat0000001', 2, 'assistant', NULL, 'msg00000001', 'x', 2)");

    await migrate(db, { migrationsFolder: after });
    const reads = await client.query<{ chat: string; user_id: string; seen_seq: number }>('SELECT chat, user_id, seen_seq FROM chat_reads ORDER BY chat, user_id');
    expect(reads.rows).toEqual([
      { chat: 'chat0000001', user_id: 'user_01ANA', seen_seq: 2 },
      { chat: 'chat0000001', user_id: 'user_01CAL', seen_seq: 2 },
      { chat: 'chat0000002', user_id: 'user_01ANA', seen_seq: 0 },
      { chat: 'chat0000002', user_id: 'user_01BEN', seen_seq: 0 },
      { chat: 'chat0000002', user_id: 'user_01DAN', seen_seq: 0 },
    ]);
    await client.query("DELETE FROM chats WHERE id = 'chat0000001'");
    expect((await client.query('SELECT 1 FROM chat_reads WHERE chat = $1', ['chat0000001'])).rows).toEqual([]);
  } finally {
    await client.close();
    rmSync(before, { recursive: true, force: true });
    rmSync(after, { recursive: true, force: true });
  }
}, PGLITE_START_MS);
