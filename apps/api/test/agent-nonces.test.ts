import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { ApiError } from '@metro-labs/http/api-error';
import { AGENT_CLOCK_SKEW_MS, type AgentProof } from '@metro-labs/http/agent-signature';
import { agentNonceStore } from '@metro-labs/connectors/db/agent-nonces';
import { agentNonces } from '../src/db/schema.js';
import { postgresFixture, TEST_DATABASE_URL } from './connector-postgres-fixture.js';
import { PGLITE_START_MS, PGLITE_STEP_MS, testDb, type TestDb } from './pglite-db.js';

let held: TestDb;
let now = Date.now();
const KEY = randomBytes(32).toString('base64url');
const OWNER = 'org_01TESTOWNER000000';
const proof = (keyId = KEY, time = now): AgentProof => ({ keyId, time, nonce: randomBytes(16).toString('base64url'), signature: '' });
const statusOf = (work: Promise<void>): Promise<number> => work.then(() => 200, (err: unknown) => (err instanceof ApiError ? err.status : 500));

beforeAll(async () => { held = await testDb(); }, PGLITE_START_MS);
beforeEach(async () => { now = Date.now(); await held.reset(); }, PGLITE_STEP_MS);
afterAll(async () => { await held.close(); });

describe('durable bounded agent nonces', () => {
  test('a duplicate is refused by a fresh store, including at the last valid signature millisecond', async () => {
    const first = proof();
    await agentNonceStore(() => held.db, () => now).consume(first, OWNER);
    now += AGENT_CLOCK_SKEW_MS;
    await expect(agentNonceStore(() => held.db, () => now).consume(first, OWNER)).rejects.toMatchObject({ status: 401 });
    expect((await held.db.select().from(agentNonces))[0]?.expiresAt).toBe(first.time + AGENT_CLOCK_SKEW_MS);
  });

  test('expired proofs never get replayed, and expired entries are pruned before budget checks', async () => {
    const store = agentNonceStore(() => held.db, () => now, { total: 1, perOwner: 1, perKey: 1 });
    const first = proof();
    await store.consume(first, OWNER);
    now += AGENT_CLOCK_SKEW_MS + 1;
    await expect(store.consume(first, OWNER)).rejects.toMatchObject({ status: 401 });
    const second = proof();
    await store.consume(second, OWNER);
    expect((await held.db.select().from(agentNonces)).map((row) => row.nonce)).toEqual([second.nonce]);
  });

  test('future timestamps are held through their entire signature window', async () => {
    const first = proof(KEY, now + AGENT_CLOCK_SKEW_MS);
    const store = agentNonceStore(() => held.db, () => now);
    await store.consume(first, OWNER);
    now += 2 * AGENT_CLOCK_SKEW_MS;
    await expect(store.consume(first, OWNER)).rejects.toMatchObject({ status: 401 });
    expect(await held.db.$count(agentNonces)).toBe(1);
  });

  test('per-key limits do not stop another key', async () => {
    const store = agentNonceStore(() => held.db, () => now, { total: 5, perOwner: 4, perKey: 1 });
    await store.consume(proof(), OWNER);
    await expect(store.consume(proof(), OWNER)).rejects.toMatchObject({ status: 429 });
    await store.consume(proof(randomBytes(32).toString('base64url')), OWNER);
    expect(await held.db.$count(agentNonces)).toBe(2);
  });

  test('per-owner limits do not stop another organization and total limits fail bounded', async () => {
    const store = agentNonceStore(() => held.db, () => now, { total: 2, perOwner: 1, perKey: 1 });
    await store.consume(proof(), OWNER);
    await expect(store.consume(proof(randomBytes(32).toString('base64url')), OWNER)).rejects.toMatchObject({ status: 429 });
    await store.consume(proof(randomBytes(32).toString('base64url')), 'org_01TESTOTHER000000');
    await expect(store.consume(proof(randomBytes(32).toString('base64url')), 'org_01TESTTHIRD000000')).rejects.toMatchObject({ status: 503 });
    expect(await held.db.$count(agentNonces)).toBe(2);
  });
});

describe.skipIf(TEST_DATABASE_URL === undefined)('agent nonces across independent PostgreSQL pools', () => {
  async function pools(work: (db: Awaited<ReturnType<typeof postgresFixture>>) => Promise<void>): Promise<void> {
    if (TEST_DATABASE_URL === undefined) throw new Error('TEST_DATABASE_URL is required');
    const pg = await postgresFixture(TEST_DATABASE_URL);
    try { await work(pg); } finally { await pg.close(); }
  }

  test('budgets are atomic across pools', () => pools(async (pg) => {
    const limits = { total: 2, perOwner: 2, perKey: 1 };
    const statuses = await Promise.all([pg.db1, pg.db2].map((db) => statusOf(agentNonceStore(() => db, Date.now, limits).consume(proof(), OWNER))));
    expect(statuses.sort((a, b) => a - b)).toEqual([200, 429]);
    expect(await pg.db1.$count(agentNonces)).toBe(1);
  }), 20_000);

  test('the same proof is consumed exactly once across pools and fresh stores', () => pools(async (pg) => {
    const same = proof();
    const statuses = await Promise.all([pg.db1, pg.db2].map((db) => statusOf(agentNonceStore(() => db, Date.now).consume(same, OWNER))));
    expect(statuses.sort((a, b) => a - b)).toEqual([200, 401]);
    expect(await statusOf(agentNonceStore(() => pg.db2, Date.now).consume(same, OWNER))).toBe(401);
    expect(await pg.db1.$count(agentNonces)).toBe(1);
  }), 20_000);
});
