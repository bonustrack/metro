import { expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { rawPublicKey } from '@metro-labs/http/agent-signature';
import { agentKeyStore } from '@metro-labs/connectors/db/agent-keys';
import * as schema from '../src/db/schema.ts';
import { enrollLegacyAgent, newEnrolledAgent } from './connector-agent-fixture.ts';
import { addAgent, PGLITE_START_MS } from './pglite-db.ts';
import { TEST_OWNER } from './identity-helper.ts';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
const TAG = '0012_agent_keys_sealing_nullable';

function through(dir: string, last: number): void {
  cpSync(DIR, dir, { recursive: true });
  const path = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(path, 'utf8')) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx <= last);
  writeFileSync(path, JSON.stringify(journal));
}

test('0012 is journaled after 0011 and only lets agent_keys.sealing_key be empty, without dropping it', () => {
  const journal = JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; when: number; tag: string }[] };
  const eleven = journal.entries.find((entry) => entry.idx === 11);
  const twelve = journal.entries.find((entry) => entry.idx === 12);
  expect(twelve).toMatchObject({ tag: TAG });
  expect(twelve?.when ?? 0).toBeGreaterThan(eleven?.when ?? Number.MAX_SAFE_INTEGER);
  expect(readFileSync(join(DIR, `${TAG}.sql`), 'utf8')).toBe('ALTER TABLE "agent_keys" ALTER COLUMN "sealing_key" DROP NOT NULL;\n');
});

test('after 0012 an enrollment without a sealing key is stored, and a key enrolled before keeps its row', async () => {
  const eleven = mkdtempSync(join(tmpdir(), 'metro-sealing-eleven-'));
  const client = new PGlite();
  const db = drizzle(client, { schema });
  const store = agentKeyStore(() => db);
  const sealing = async (): Promise<{ agent: string; sealing_key: string | null }[]> =>
    (await client.query<{ agent: string; sealing_key: string | null }>('SELECT agent, sealing_key FROM agent_keys ORDER BY agent')).rows;
  try {
    through(eleven, 11);
    await migrate(db, { migrationsFolder: eleven });
    const legacy = newEnrolledAgent('agent000001');
    await enrollLegacyAgent(db, legacy);
    const [before] = await sealing();
    expect(before?.sealing_key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const fresh = newEnrolledAgent('agent000002');
    await addAgent(db, fresh.row.agent, TEST_OWNER);
    await expect(store.enroll(fresh.row)).rejects.toThrow();

    await migrate(db, { migrationsFolder: DIR });
    const nullable = await client.query<{ is_nullable: string }>("SELECT is_nullable FROM information_schema.columns WHERE table_name = 'agent_keys' AND column_name = 'sealing_key'");
    expect(nullable.rows).toEqual([{ is_nullable: 'YES' }]);
    expect(await sealing()).toEqual([{ agent: 'agent000001', sealing_key: before?.sealing_key ?? '' }]);
    expect(await store.find(legacy.row.keyId)).toEqual(legacy.row);

    await store.enroll(fresh.row);
    expect(await store.find(fresh.row.keyId)).toEqual(fresh.row);
    const again = newEnrolledAgent('agent000001');
    await store.enroll(again.row);
    expect(await store.find(again.row.keyId)).toEqual(again.row);
    expect(await store.find(legacy.row.keyId)).toBeNull();
    expect(await sealing()).toEqual([{ agent: 'agent000001', sealing_key: before?.sealing_key ?? '' }, { agent: 'agent000002', sealing_key: null }]);

    const overlap = newEnrolledAgent('agent000003');
    await addAgent(db, overlap.row.agent, TEST_OWNER);
    const { agent, owner, keyId, signingKey, enrolledBy, enrolledAt } = overlap.row;
    await client.query('INSERT INTO agent_keys (agent, owner, key_id, signing_key, sealing_key, enrolled_by, enrolled_at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [agent, owner, keyId, signingKey, rawPublicKey(generateKeyPairSync('x25519').publicKey), enrolledBy, enrolledAt]);
    expect(await store.find(keyId)).toEqual(overlap.row);
    expect((await client.query('SELECT * FROM box_keys')).rows).toHaveLength(3);
  } finally {
    await client.close();
    rmSync(eleven, { recursive: true, force: true });
  }
}, PGLITE_START_MS);
