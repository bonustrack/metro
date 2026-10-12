import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { agentKeyStore, leaveOrganization } from '../src/db/agent-keys.js';
import { orgConnectorStore } from '../src/db/connectors.js';
import { agents, connectorAgents, connectorEvents, connectorMigrations, connectors } from '../src/db/schema.js';
import { fullPolicy, openConnectorSecret } from '../src/connectors/model.js';
import { updateConnector } from '../src/connectors/manage.js';
import { enrollDeliveryAgent, latch, MASTER, newDeliveryAgent, opaque, openResponse, seedConnector, signedDelivery, startDeliveryApi, type DeliveryAgent } from './connector-delivery-fixture.js';
import { answer, input, MIGRATION_PATH, payload, prepared, prepareInput, startMigrationApi, type MigrationApi } from './connector-migration-fixture.js';
import { PGLITE_START_MS, PGLITE_STEP_MS, testDb, type TestDb } from './pglite-db.js';
import { TEST_OWNER, TEST_STRANGER } from './identity-helper.js';

let held: TestDb;
let api: MigrationApi;
let agent: DeliveryAgent;
const assignment = (connector: string, id = agent.row.agent) => ({ owner: TEST_OWNER, connector, agent: id, policy: null, actor: 'user_01TEST', at: new Date().toISOString() });

async function moved(): Promise<void> {
  await held.db.transaction(async (tx) => {
    await tx.select().from(agents).where(eq(agents.id, agent.row.agent)).for('update');
    await leaveOrganization(tx, agent.row.agent, TEST_OWNER, new Date().toISOString());
    await tx.update(agents).set({ owner: TEST_STRANGER }).where(eq(agents.id, agent.row.agent));
  });
}

describe('signed organization connector migration HTTP API', () => {
  beforeAll(async () => {
    held = await testDb();
    api = await startMigrationApi(held.db);
  }, PGLITE_START_MS);
  beforeEach(async () => {
    await held.reset();
    agent = newDeliveryAgent();
    await enrollDeliveryAgent(held.db, agent);
  });
  afterAll(async () => {
    await api?.close();
    await held?.close();
  });

  test('lost responses retry through restart, prepare stays unassigned and rollback retains destination', async () => {
    const source = payload();
    const begin = await answer(await api.call(agent, input('begin')));
    const restarted = await startMigrationApi(held.db);
    try {
      const retried = await answer(await restarted.call(agent, input('begin')));
      expect(retried).toEqual(begin);
      const request = prepareInput(begin, source);
      const ready = await answer(await api.call(agent, request));
      expect((await answer(await restarted.call(agent, request))).migration).toEqual(ready.migration);
      expect(ready.migration.phase).toBe('prepared');
      expect(ready.migration.readiness).toBe('ready');
      expect(await held.db.$count(connectors)).toBe(1);
      expect(await held.db.$count(connectorAgents)).toBe(0);
      const stored = (await held.db.select().from(connectors))[0];
      if (stored === undefined) throw new Error('missing connector');
      expect(stored.url).toBe('https://vendor.example');
      expect(openConnectorSecret(MASTER, stored)).toEqual({ ...source.auth, targetUrl: source.url });
      expect(fullPolicy(stored.policy)).toEqual(source.policy);
      const serialized = JSON.stringify({ mappings: await held.db.select().from(connectorMigrations), connectors: await held.db.select().from(connectors), events: await held.db.select().from(connectorEvents), response: ready });
      expect(serialized).not.toContain('URL_SECRET');
      expect(serialized).not.toContain(source.auth.kind === 'header' ? source.auth.value : 'unused-secret');
      expect((await answer(await api.call(agent, input('activate')))).migration.phase).toBe('active');
      expect((await answer(await restarted.call(agent, input('activate')))).migration.phase).toBe('active');
      expect(await held.db.$count(connectorAgents)).toBe(1);
      const delivery = await startDeliveryApi(held.db);
      try {
        const requestId = opaque();
        const snapshot = await openResponse(await delivery.call(agent, { requestId }), agent, requestId);
        expect(snapshot.connectors[0]?.policy).toEqual(source.policy);
      } finally { await delivery.close(); }
      expect((await answer(await api.call(agent, input('rollback')))).migration.phase).toBe('rolled_back');
      expect((await answer(await restarted.call(agent, input('rollback')))).migration.phase).toBe('rolled_back');
      expect(await held.db.$count(connectors)).toBe(1);
      expect(await held.db.$count(connectorAgents)).toBe(0);
    } finally { await restarted.close(); }
  }, PGLITE_STEP_MS);

  test('rollback before begin is terminal and old generations cannot affect a new operation', async () => {
    const rolled = await answer(await api.call(agent, input('rollback')));
    expect(rolled.migration.phase).toBe('rolled_back');
    const old = await answer(await api.call(agent, input('begin')));
    expect(old.migration.phase).toBe('rolled_back');
    expect((await api.call(agent, prepareInput(old, payload()))).status).toBe(409);
    const next = await answer(await api.call(agent, input('begin', 'oper0000002')));
    expect(next.migration.destinationId).not.toBe(old.migration.destinationId);
    for (const action of ['begin', 'status', 'activate', 'rollback']) expect((await api.call(agent, input(action))).status).toBe(409);
    expect((await api.call(agent, prepareInput(old, payload()))).status).toBe(409);
    expect((await answer(await api.call(agent, input('status', 'oper0000002')))).migration.phase).toBe('preparing');
  });

  test('matching names and endpoints never merge, prepared destinations cannot be assigned or toggled', async () => {
    const source = payload();
    const existing = await seedConnector(held.db, { kind: 'none', targetUrl: source.url });
    const begin = await answer(await api.call(agent, input('begin')));
    const ready = await answer(await api.call(agent, prepareInput(begin, source)));
    expect(await held.db.$count(connectors)).toBe(2);
    expect((await held.db.select().from(connectors).where(eq(connectors.id, existing.id)))[0]).toEqual(existing);
    const id = ready.migration.destinationId;
    expect(id).not.toBe(existing.id);
    await expect(orgConnectorStore(() => held.db).assign(assignment(id))).rejects.toThrow('Finish or roll back');
    await expect(orgConnectorStore(() => held.db).edit(TEST_OWNER, id, new Date().toISOString(), () => ({ change: { policy: null }, event: null }))).rejects.toThrow('Finish or roll back');
    expect(await held.db.$count(connectorAgents)).toBe(0);
  });

  test('rollback removes only unchanged operation-owned assignment and preserves other agents', async () => {
    const ready = await prepared(api, agent);
    const id = ready.migration.destinationId;
    await answer(await api.call(agent, input('activate')));
    const other = newDeliveryAgent('agent000002');
    await enrollDeliveryAgent(held.db, other);
    const store = orgConnectorStore(() => held.db);
    await store.assign(assignment(id, other.row.agent));
    await store.assign(assignment(id));
    expect((await api.call(agent, input('activate'))).status).toBe(409);
    await answer(await api.call(agent, input('rollback')));
    expect(await held.db.$count(connectorAgents)).toBe(2);
    expect(await held.db.$count(connectors)).toBe(1);
  });

  test('delete and recreate of the same grant is not owned by rollback', async () => {
    const ready = await prepared(api, agent);
    await answer(await api.call(agent, input('activate')));
    const store = orgConnectorStore(() => held.db);
    await store.unassign(assignment(ready.migration.destinationId));
    await store.assign(assignment(ready.migration.destinationId));
    await answer(await api.call(agent, input('rollback')));
    expect(await held.db.$count(connectorAgents)).toBe(1);
  });

  test('custom policies remain visible and a readOnly edit never replaces their tool overrides', async () => {
    const ready = await prepared(api, agent);
    await answer(await api.call(agent, input('activate')));
    const caller = { owner: TEST_OWNER, session: { userId: 'user_01TEST', sessionId: 'session_test', organization: TEST_OWNER, role: 'admin', expiresAt: Date.now() + 60_000 } };
    const deps = { ...api.deps, store: orgConnectorStore(() => held.db) };
    await expect(updateConnector(deps, caller, ready.migration.destinationId, { readOnly: false })).rejects.toThrow('custom policy');
    const row = await deps.store.find(TEST_OWNER, ready.migration.destinationId);
    expect(fullPolicy(row?.policy ?? null)).toEqual({ write: 'deny', tools: { special: 'ask' } });
  });

  test('changed policy or static configuration blocks cutover without overwriting it', async () => {
    const ready = await prepared(api, agent);
    await held.db.update(connectors).set({ policy: '{"write":"allow"}' }).where(eq(connectors.id, ready.migration.destinationId));
    expect((await answer(await api.call(agent, input('status')))).migration.readiness).toBe('changed');
    expect((await api.call(agent, input('activate'))).status).toBe(409);
    expect(await held.db.$count(connectorAgents)).toBe(0);
  });

  test('browser, tampered context, disabled delivery and durable nonce replay fail closed', async () => {
    expect((await api.call(agent, input('begin'), { origin: 'https://metro.box' })).status).toBe(403);
    const begin = await answer(await api.call(agent, input('begin')));
    const wrong = { ...begin, receiving: begin.receiving === undefined ? undefined : { ...begin.receiving, context: { ...begin.receiving.context, sourceId: 'local000002' } } };
    const failed = await api.call(agent, prepareInput(wrong, payload()));
    expect(failed.status).toBe(409);
    expect(await failed.text()).not.toContain('SECRET');
    const signed = signedDelivery(agent, input('status'), Date.now(), MIGRATION_PATH);
    expect((await fetch(`${api.base}${MIGRATION_PATH}`, { method: 'POST', ...signed })).status).toBe(200);
    const restarted = await startMigrationApi(held.db);
    const disabled = await startMigrationApi(held.db, { deliveryEnabled: () => false });
    try {
      expect((await fetch(`${restarted.base}${MIGRATION_PATH}`, { method: 'POST', ...signed })).status).toBe(401);
      expect((await disabled.call(agent, input('begin'))).status).toBe(503);
    } finally { await restarted.close(); await disabled.close(); }
  });

  test('re-enrollment during slow prepare fails the fresh transaction binding check', async () => {
    const hold = latch();
    const slow = await startMigrationApi(held.db, { fetch: async (...args) => { await hold.pause(); return api.deps.fetch(...args); } });
    try {
      const begin = await answer(await slow.call(agent, input('begin')));
      const pending = slow.call(agent, prepareInput(begin, payload()));
      await hold.reached;
      const replacement = newDeliveryAgent();
      await agentKeyStore(() => held.db).enroll(replacement.row);
      hold.release();
      expect((await pending).status).toBe(401);
      expect(await held.db.$count(connectors)).toBe(0);
      expect((await slow.call(replacement, input('status'))).status).toBe(409);
    } finally { hold.release(); await slow.close(); }
  });

  test('organization move during slow activation creates no assignment', async () => {
    await prepared(api, agent);
    const hold = latch();
    const slow = await startMigrationApi(held.db, { fetch: async (...args) => { await hold.pause(); return api.deps.fetch(...args); } });
    try {
      const pending = slow.call(agent, input('activate'));
      await hold.reached;
      await moved();
      hold.release();
      expect((await pending).status).toBe(401);
      expect(await held.db.$count(connectorAgents)).toBe(0);
      expect(await held.db.$count(connectors)).toBe(1);
    } finally { hold.release(); await slow.close(); }
  });
});
