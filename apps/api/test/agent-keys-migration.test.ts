import { expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { agentSignatureValid, readAgentProof, signAgentRequest } from '@metro-labs/http/agent-signature';
import { newAgentKey } from '../../daemon/src/connectors/agent-key.ts';
import { agentKeyStore } from '../src/db/agent-keys.ts';
import type { Database } from '../src/db/client.ts';
import * as schema from '../src/db/schema.ts';
import { PGLITE_START_MS } from './pglite-db.ts';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
const OWNER = 'org_01MIGRATIONTEST';
const AT = '2026-10-09T00:00:00.000Z';
const FIRST = newAgentKey();
const SECOND = newAgentKey();

function phaseOne(dir: string): void {
  cpSync(DIR, dir, { recursive: true });
  const path = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(path, 'utf8')) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx <= 4);
  writeFileSync(path, JSON.stringify(journal));
}

async function seed(client: PGlite): Promise<void> {
  for (const [id, key] of [['agent000001', FIRST], ['agent000002', SECOND]] as const) {
    await client.query('INSERT INTO agents (id, owner, host, added_at, slug) VALUES ($1, $2, $3, $4, $1)', [id, OWNER, `${id}.example`, AT]);
    await client.query('INSERT INTO box_keys VALUES ($1, $2, $3, $4, $5, $6, $7)', [id, OWNER, key.keyId, key.signingKey, key.sealingKey, 'user_01TEST', AT]);
  }
  await client.query("INSERT INTO connectors (id, owner, name, url, auth, policy, secret, created_by, created_at, updated_at) VALUES ('conn0000001', $1, 'Existing connector', 'https://vendor.example', 'header', $2, 'sealed-fixture-unchanged', 'user_01TEST', $3, $3)", [OWNER, '{"write":"deny"}', AT]);
  await client.query("INSERT INTO connector_agents VALUES ('conn0000001', 'agent000001', $1, 'user_01TEST', $2)", ['{"write":"deny"}', AT]);
  await client.query("INSERT INTO connector_events VALUES ('event000001', $1, null, 'agent000001', 'user:user_01TEST', 'box.enrolled', $2, $3)", [OWNER, JSON.stringify({ keyId: FIRST.keyId }), AT]);
}

const rows = async (client: PGlite, table: string): Promise<Record<string, unknown>[]> => (await client.query<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY 1`)).rows;

async function constraints(client: PGlite): Promise<void> {
  const renamed = await client.query<{ conname: string }>("SELECT conname FROM pg_constraint WHERE conrelid = 'agent_keys'::regclass AND contype IN ('p', 'f') ORDER BY conname");
  expect(renamed.rows.map((row) => row.conname)).toEqual(['agent_keys_agent_agents_id_fk', 'agent_keys_pkey']);
  const index = await client.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE tablename = 'agent_keys' ORDER BY indexname");
  expect(index.rows.map((row) => row.indexname)).toEqual(['agent_keys_key_id_idx', 'agent_keys_pkey']);
  await expect(client.query("INSERT INTO agent_keys SELECT 'missing0001', owner, 'fresh-key-id', signing_key, sealing_key, enrolled_by, enrolled_at FROM agent_keys LIMIT 1")).rejects.toThrow();
  await expect(client.query("UPDATE agent_keys SET key_id = $1 WHERE agent = 'agent000002'", [FIRST.keyId])).rejects.toThrow();
  await expect(client.query('INSERT INTO agent_keys SELECT * FROM agent_keys LIMIT 1')).rejects.toThrow();
}

async function signingStillWorks(db: Database): Promise<void> {
  const row = await agentKeyStore(() => db).find(FIRST.keyId);
  expect(row).toMatchObject({ agent: 'agent000001', owner: OWNER, keyId: FIRST.keyId, signingKey: FIRST.signingKey, sealingKey: FIRST.sealingKey, enrolledBy: 'user_01TEST', enrolledAt: AT });
  const request = { method: 'GET', host: 'api.metro.box', path: '/api/agents/session', body: Buffer.alloc(0) };
  const proof = readAgentProof(signAgentRequest(request, FIRST.signing, FIRST.keyId, Date.now()));
  if (proof === null || row === null) throw new Error('migrated key missing');
  expect(agentSignatureValid(request, proof, row.signingKey)).toBe(true);
}

async function oldMoveAndCascade(client: PGlite): Promise<void> {
  const moved = await client.query<{ key_id: string }>("DELETE FROM box_keys WHERE agent = 'agent000002' RETURNING key_id");
  expect(moved.rows).toEqual([{ key_id: SECOND.keyId }]);
  expect((await rows(client, 'agent_keys')).length).toBe(1);
  await client.query("DELETE FROM agents WHERE id = 'agent000001'");
  expect(await rows(client, 'agent_keys')).toEqual([]);
  expect(await rows(client, 'connector_agents')).toEqual([]);
  expect((await rows(client, 'connector_events')).length).toBe(1);
  expect((await rows(client, 'connectors')).length).toBe(1);
}

test('the deployed phase-one database upgrades without replacing keys, assignments, secrets or audit history', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'metro-agent-keys-migration-'));
  const client = new PGlite();
  const db = drizzle(client, { schema });
  try {
    phaseOne(folder);
    await migrate(db, { migrationsFolder: folder });
    await seed(client);
    const keys = await rows(client, 'box_keys');
    const assignments = await rows(client, 'connector_agents');
    const events = await rows(client, 'connector_events');
    const connectors = await rows(client, 'connectors');
    const journal = await rows(client, 'drizzle.__drizzle_migrations');
    await migrate(db, { migrationsFolder: DIR });
    expect(await rows(client, 'agent_keys')).toEqual(keys);
    expect(await rows(client, 'box_keys')).toEqual(keys);
    expect(await rows(client, 'connector_agents')).toEqual(assignments);
    expect(await rows(client, 'connector_events')).toEqual(events);
    expect(await rows(client, 'connectors')).toEqual(connectors.map((row) => ({ ...row, detail: null, auth_generation: null })));
    expect((await rows(client, 'drizzle.__drizzle_migrations')).slice(0, journal.length)).toEqual(journal);
    const relations = await client.query<{ relname: string; relkind: string }>("SELECT relname, relkind FROM pg_class WHERE relname IN ('agent_keys', 'box_keys') ORDER BY relname");
    expect(relations.rows).toEqual([{ relname: 'agent_keys', relkind: 'r' }, { relname: 'box_keys', relkind: 'v' }]);
    const applied = await rows(client, 'drizzle.__drizzle_migrations');
    await migrate(db, { migrationsFolder: DIR });
    expect(await rows(client, 'drizzle.__drizzle_migrations')).toEqual(applied);
    expect(await rows(client, 'agent_keys')).toEqual(keys);
    await constraints(client);
    await signingStillWorks(db);
    await oldMoveAndCascade(client);
  } finally {
    await client.close();
    rmSync(folder, { recursive: true, force: true });
  }
}, PGLITE_START_MS);
