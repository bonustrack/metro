import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { AGENT_CLOCK_SKEW_MS, type AgentProof } from '@metro-labs/http/agent-signature';
import { agentNonceStore } from '../src/db/agent-nonces.js';
import { agentNonces } from '../src/db/schema.js';
import { PGLITE_START_MS, PGLITE_STEP_MS, testDb, type TestDb } from './pglite-db.js';

let held: TestDb;
let now = Date.now();
const KEY = randomBytes(32).toString('base64url');
const OWNER = 'org_01TESTOWNER000000';
const proof = (keyId = KEY, time = now): AgentProof => ({ keyId, time, nonce: randomBytes(16).toString('base64url'), signature: '' });

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
