import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { agentKeyStore, leaveOrganization } from '../src/db/agent-keys.js';
import { orgConnectorStore } from '../src/db/connectors.js';
import { agents, connectorAgents, connectorMigrations, connectors } from '../src/db/schema.js';
import { enrollDeliveryAgent, latch, newDeliveryAgent, type DeliveryAgent } from './connector-delivery-fixture.js';
import { answer, input, payload, prepared, prepareInput, startMigrationApi, verifiedFetch, type MigrationApi } from './connector-migration-fixture.js';
import { postgresFixture, TEST_DATABASE_URL } from './connector-postgres-fixture.js';
import { TEST_OWNER, TEST_STRANGER } from './identity-helper.js';

let held: Awaited<ReturnType<typeof postgresFixture>>;
let agent: DeliveryAgent;
let one: MigrationApi;
let two: MigrationApi;

describe.skipIf(TEST_DATABASE_URL === undefined)('connector migration with independent real Postgres API pools', () => {
  beforeAll(async () => {
    if (TEST_DATABASE_URL === undefined) throw new Error('TEST_DATABASE_URL is required');
    held = await postgresFixture(TEST_DATABASE_URL);
    one = await startMigrationApi(held.db1);
    two = await startMigrationApi(held.db2);
  }, 30_000);
  beforeEach(async () => {
    await held.reset();
    agent = newDeliveryAgent();
    await enrollDeliveryAgent(held.db1, agent);
  });
  afterAll(async () => { await one?.close(); await two?.close(); await held?.close(); });

  test('concurrent begin, prepare and activate retries create one destination and one owned assignment', async () => {
    const [left, right] = await Promise.all([one.call(agent, input('begin')), two.call(agent, input('begin'))]);
    const a = await answer(left);
    expect(await answer(right)).toEqual(a);
    const request = prepareInput(a, payload());
    const preparedResponses = await Promise.all([one.call(agent, request), two.call(agent, request)]);
    expect(await answer(preparedResponses[0] ?? new Response())).toEqual(await answer(preparedResponses[1] ?? new Response()));
    expect(await held.db1.$count(connectors)).toBe(1);
    expect(await held.db1.$count(connectorAgents)).toBe(0);
    const activated = await Promise.all([one.call(agent, input('activate')), two.call(agent, input('activate'))]);
    expect(activated.map((response) => response.status)).toEqual([200, 200]);
    expect(await held.db1.$count(connectorAgents)).toBe(1);
    expect(await held.db1.$count(connectorMigrations)).toBe(1);
    const rollback = await Promise.all([one.call(agent, input('rollback')), two.call(agent, input('rollback'))]);
    expect(rollback.map((response) => response.status)).toEqual([200, 200]);
    expect(await held.db1.$count(connectorAgents)).toBe(0);
    expect(await held.db1.$count(connectors)).toBe(1);
  });

  test('competing operation IDs for one source never create parallel generations', async () => {
    const replies = await Promise.all([one.call(agent, input('begin')), two.call(agent, input('begin', 'oper0000002'))]);
    expect(replies.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await held.db1.$count(connectorMigrations)).toBe(1);
    expect(await held.db1.$count(connectors)).toBe(0);
  });

  test('a policy edit during verification blocks cutover under the connector lock', async () => {
    const ready = await prepared(one, agent);
    const hold = latch();
    one.deps.fetch = async (...args) => { await hold.pause(); return verifiedFetch(...args); };
    try {
      const activating = one.call(agent, input('activate'));
      await hold.reached;
      await held.db2.update(connectors).set({ policy: '{"write":"allow"}' }).where(eq(connectors.id, ready.migration.destinationId));
      hold.release();
      expect((await activating).status).toBe(409);
      expect(await held.db1.$count(connectorAgents)).toBe(0);
      expect((await answer(await two.call(agent, input('status')))).migration.readiness).toBe('changed');
    } finally { hold.release(); one.deps.fetch = verifiedFetch; }
  });

  test('the same key re-enrolled during prepare cannot commit with the old enrollment', async () => {
    const begin = await answer(await one.call(agent, input('begin')));
    const hold = latch();
    one.deps.fetch = async (...args) => { await hold.pause(); return verifiedFetch(...args); };
    try {
      const preparing = one.call(agent, prepareInput(begin, payload()));
      await hold.reached;
      await agentKeyStore(() => held.db2).enroll({ ...agent.row, enrolledAt: new Date(Date.now() + 1000).toISOString() });
      hold.release();
      expect((await preparing).status).toBe(401);
      expect(await held.db1.$count(connectors)).toBe(0);
    } finally { hold.release(); one.deps.fetch = verifiedFetch; }
  });

  test('an organization move completes while verification is pending and prevents the commit', async () => {
    await prepared(one, agent);
    const hold = latch();
    one.deps.fetch = async (...args) => { await hold.pause(); return verifiedFetch(...args); };
    try {
      const activating = one.call(agent, input('activate'));
      await hold.reached;
      await held.db2.transaction(async (tx) => {
        await tx.select().from(agents).where(eq(agents.id, agent.row.agent)).for('update');
        await leaveOrganization(tx, agent.row.agent);
        await tx.update(agents).set({ owner: TEST_STRANGER }).where(eq(agents.id, agent.row.agent));
      });
      hold.release();
      expect((await activating).status).toBe(401);
      expect(await held.db1.$count(connectorAgents)).toBe(0);
    } finally { hold.release(); one.deps.fetch = verifiedFetch; }
  });

  test('rollback waits for an ordinary assignment edit then preserves that grant and all other agents', async () => {
    const ready = await prepared(one, agent);
    await answer(await one.call(agent, input('activate')));
    const other = newDeliveryAgent('agent000002');
    await enrollDeliveryAgent(held.db1, other);
    const base = { owner: TEST_OWNER, connector: ready.migration.destinationId, policy: null, actor: 'user_01TEST', at: new Date().toISOString() };
    await orgConnectorStore(() => held.db2).assign({ ...base, agent: other.row.agent });
    const hold = latch();
    const edit = held.db2.transaction(async (tx) => {
      await tx.select().from(connectors).where(eq(connectors.id, ready.migration.destinationId)).for('update');
      await hold.pause();
      await orgConnectorStore(() => tx).assign({ ...base, agent: agent.row.agent, policy: '{"write":"deny"}' });
    });
    await hold.reached;
    const rolling = one.call(agent, input('rollback'));
    try {
      await held.waiting('one');
      hold.release();
      await edit;
      expect((await rolling).status).toBe(200);
      expect(await held.db1.$count(connectorAgents)).toBe(2);
      expect(await held.db1.$count(connectors)).toBe(1);
    } finally { hold.release(); await edit; }
  });
});
