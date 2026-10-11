import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { agents, boxKeys, connectorAgents, connectorEvents, connectors } from '../src/db/schema.ts';
import { openSecret, sealSecret } from '../src/connectors/secrets.ts';
import { addAgent, PGLITE_START_MS, PGLITE_STEP_MS, testDb, type TestDb } from './pglite-db.ts';

const OWNER = 'org_01TESTOWNER000000';
const STRANGER = 'org_01TESTSTRANGER00';
const TOKEN = 'harmless-vendor-token-fixture';
const AT = '2026-10-09T00:00:00.000Z';

let held: TestDb;
const key = randomBytes(32);

const connector = (id: string, owner: string, name: string, secret: string | null = null): typeof connectors.$inferInsert => ({
  id, owner, name, url: 'https://vendor.example/mcp', auth: secret === null ? 'none' : 'header', policy: null, secret, createdBy: 'user_01TEST', createdAt: AT, updatedAt: AT,
});

const settled = (query: PromiseLike<unknown>): Promise<unknown> => Promise.resolve(query);

const assignment = (connectorId: string, agent: string): typeof connectorAgents.$inferInsert => ({ connector: connectorId, agent, policy: '{"write":"deny"}', createdBy: 'user_01TEST', createdAt: AT });

beforeAll(async () => {
  held = await testDb();
}, PGLITE_START_MS);

beforeEach(async () => {
  await held.reset();
  await addAgent(held.db, 'agent000001', OWNER);
  await addAgent(held.db, 'agent000002', OWNER);
  await addAgent(held.db, 'agent000003', STRANGER);
}, PGLITE_STEP_MS);

afterAll(async () => {
  await held.close();
});

describe('the organization connector tables', () => {
  test('the migration creates every table with its columns', async () => {
    const result = await held.client.query<{ table_name: string; column_name: string }>(
      "select table_name, column_name from information_schema.columns where table_schema = 'public' and table_name in ('connectors','connector_agents','connector_events','box_keys') order by table_name, ordinal_position",
    );
    const columns: Record<string, string[]> = {};
    for (const row of result.rows) (columns[row.table_name] ??= []).push(row.column_name);
    expect(columns).toEqual({
      box_keys: ['agent', 'owner', 'key_id', 'signing_key', 'sealing_key', 'enrolled_by', 'enrolled_at'],
      connector_agents: ['connector', 'agent', 'policy', 'created_by', 'created_at'],
      connector_events: ['id', 'owner', 'connector', 'agent', 'actor', 'action', 'detail', 'at'],
      connectors: ['id', 'owner', 'name', 'url', 'auth', 'policy', 'secret', 'created_by', 'created_at', 'updated_at'],
    });
  });

  test('a connector name is unique inside its organization only', async () => {
    await held.db.insert(connectors).values(connector('conn0000001', OWNER, 'Linear'));
    await held.db.insert(connectors).values(connector('conn0000002', STRANGER, 'Linear'));
    await expect(settled(held.db.insert(connectors).values(connector('conn0000003', OWNER, 'Linear')))).rejects.toThrow();
  });

  test('an assignment goes with its connector or its agent, the audit log stays', async () => {
    await held.db.insert(connectors).values([connector('conn0000001', OWNER, 'Linear'), connector('conn0000002', OWNER, 'Notion')]);
    await held.db.insert(connectorAgents).values([assignment('conn0000001', 'agent000001'), assignment('conn0000001', 'agent000002'), assignment('conn0000002', 'agent000001')]);
    await held.db.insert(connectorEvents).values({ id: 'event000001', owner: OWNER, connector: 'conn0000001', agent: null, actor: 'user:user_01TEST', action: 'connector.created', detail: null, at: AT });
    await expect(settled(held.db.insert(connectorAgents).values(assignment('conn0000001', 'agent000001')))).rejects.toThrow();
    await expect(settled(held.db.insert(connectorAgents).values(assignment('missing0001', 'agent000001')))).rejects.toThrow();
    await held.db.delete(connectors).where(eq(connectors.id, 'conn0000001'));
    expect(await held.db.select().from(connectorAgents)).toEqual([assignment('conn0000002', 'agent000001')]);
    await held.db.delete(agents).where(eq(agents.id, 'agent000001'));
    expect(await held.db.select().from(connectorAgents)).toEqual([]);
    expect((await held.db.select().from(connectorEvents)).map((row) => row.action)).toEqual(['connector.created']);
  });

  test('a box key belongs to one agent, goes with it, and a key id is used once', async () => {
    const row = { agent: 'agent000001', owner: OWNER, keyId: 'k'.repeat(43), signingKey: 's'.repeat(43), sealingKey: 'x'.repeat(43), enrolledBy: 'user_01TEST', enrolledAt: AT };
    await held.db.insert(boxKeys).values(row);
    await expect(settled(held.db.insert(boxKeys).values({ ...row, agent: 'agent000002' }))).rejects.toThrow();
    await held.db.delete(agents).where(eq(agents.id, 'agent000001'));
    expect(await held.db.select().from(boxKeys)).toEqual([]);
  });
});

describe('connector secrets in the database', () => {
  test('a secret is kept sealed and opens only with the key, for its own organization and connector', async () => {
    const sealed = sealSecret(key, OWNER, 'conn0000001', { auth: { kind: 'header', name: 'Authorization', value: TOKEN } });
    await held.db.insert(connectors).values(connector('conn0000001', OWNER, 'Linear', sealed));
    const stored = (await held.db.select().from(connectors))[0]?.secret ?? '';
    expect(stored).toBe(sealed);
    expect(sealed).not.toContain(TOKEN);
    expect(Buffer.from(sealed.slice(3), 'base64url').toString('latin1')).not.toContain(TOKEN);
    expect(openSecret(key, OWNER, 'conn0000001', stored)).toEqual({ auth: { kind: 'header', name: 'Authorization', value: TOKEN } });
    expect(() => openSecret(key, OWNER, 'conn0000002', stored)).toThrow('could not be opened');
    expect(() => openSecret(key, STRANGER, 'conn0000001', stored)).toThrow('could not be opened');
    expect(() => openSecret(randomBytes(32), OWNER, 'conn0000001', stored)).toThrow('could not be opened');
  });
});
