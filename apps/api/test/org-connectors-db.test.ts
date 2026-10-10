import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { connectorKeyStore } from '../src/db/connector-keys.ts';
import { agents, boxKeys, connectorAgents, connectorEvents, connectorKeys, connectors } from '../src/db/schema.ts';
import { Keyring } from '../src/connectors/keyring.ts';
import { localWrapper } from '../src/connectors/key-wrappers.ts';
import { addAgent, testDb, type TestDb } from './pglite-db.ts';

const OWNER = 'org_01TESTOWNER000000';
const STRANGER = 'org_01TESTSTRANGER00';
const TOKEN = 'harmless-vendor-token-fixture';
const AT = '2026-10-09T00:00:00.000Z';

let held: TestDb;
const wrapper = localWrapper(randomBytes(32));
const keyringFor = (): Keyring => new Keyring({ wrapper, store: connectorKeyStore(() => held.db), now: () => Date.now() });

const connector = (id: string, owner: string, name: string, secret: string | null = null): typeof connectors.$inferInsert => ({
  id, owner, name, url: 'https://vendor.example/mcp', auth: secret === null ? 'none' : 'header', policy: null, secret, createdBy: 'user_01TEST', createdAt: AT, updatedAt: AT,
});

const settled = (query: PromiseLike<unknown>): Promise<unknown> => Promise.resolve(query);

const assignment = (connectorId: string, agent: string): typeof connectorAgents.$inferInsert => ({ connector: connectorId, agent, policy: '{"write":"deny"}', createdBy: 'user_01TEST', createdAt: AT });

beforeAll(async () => {
  held = await testDb();
});

beforeEach(async () => {
  await held.reset();
  await addAgent(held.db, 'agent000001', OWNER);
  await addAgent(held.db, 'agent000002', OWNER);
  await addAgent(held.db, 'agent000003', STRANGER);
});

afterAll(async () => {
  await held.close();
});

describe('the organization connector tables', () => {
  test('the migration creates every table with its columns', async () => {
    const result = await held.client.query<{ table_name: string; column_name: string }>(
      "select table_name, column_name from information_schema.columns where table_schema = 'public' and table_name in ('connector_keys','connectors','connector_agents','connector_events','box_keys') order by table_name, ordinal_position",
    );
    const columns: Record<string, string[]> = {};
    for (const row of result.rows) (columns[row.table_name] ??= []).push(row.column_name);
    expect(columns).toEqual({
      box_keys: ['agent', 'owner', 'key_id', 'signing_key', 'sealing_key', 'enrolled_by', 'enrolled_at'],
      connector_agents: ['connector', 'agent', 'policy', 'created_by', 'created_at'],
      connector_events: ['id', 'owner', 'connector', 'agent', 'actor', 'action', 'detail', 'at'],
      connector_keys: ['owner', 'wrapped', 'wrapping', 'created_at'],
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
  test('a secret is kept sealed with the organization key and opens only for its own connector', async () => {
    const keyring = keyringFor();
    const sealed = await keyring.seal(OWNER, 'conn0000001', { auth: { kind: 'header', name: 'Authorization', value: TOKEN } });
    await held.db.insert(connectors).values(connector('conn0000001', OWNER, 'Linear', sealed));
    const stored = (await held.db.select().from(connectors))[0];
    expect(stored?.secret).toBe(sealed);
    expect(sealed).not.toContain(TOKEN);
    expect(Buffer.from(sealed.slice(3), 'base64url').toString('latin1')).not.toContain(TOKEN);
    expect(await keyringFor().open(OWNER, 'conn0000001', stored?.secret ?? '')).toEqual({ auth: { kind: 'header', name: 'Authorization', value: TOKEN } });
    await expect(keyring.open(OWNER, 'conn0000002', sealed)).rejects.toThrow('could not be opened');
    await expect(keyring.open(STRANGER, 'conn0000001', sealed)).rejects.toThrow('could not be opened');
  });

  test('each organization gets its own data key, stored only wrapped', async () => {
    const keyring = keyringFor();
    const ours = await keyring.seal(OWNER, 'conn0000001', { value: TOKEN });
    await keyring.seal(STRANGER, 'conn0000001', { value: TOKEN });
    const rows = await held.db.select().from(connectorKeys);
    expect(rows.map((row) => row.owner).sort()).toEqual([OWNER, STRANGER].sort());
    for (const row of rows) {
      expect(row.wrapping).toBe(wrapper.id);
      expect(row.wrapped.startsWith('v1.')).toBe(true);
      expect(Buffer.from(row.wrapped.slice(3), 'base64url').length).toBe(12 + 16 + 32);
    }
    const theirs = rows.find((row) => row.owner === STRANGER);
    if (theirs === undefined) throw new Error('no key for the stranger');
    await held.db.update(connectorKeys).set({ wrapped: theirs.wrapped }).where(eq(connectorKeys.owner, OWNER));
    await expect(keyringFor().open(OWNER, 'conn0000001', ours)).rejects.toThrow('could not be opened');
  });

  test('a database without the wrapping key opens nothing', async () => {
    await keyringFor().seal(OWNER, 'conn0000001', { value: TOKEN });
    const other = new Keyring({ wrapper: localWrapper(randomBytes(32)), store: connectorKeyStore(() => held.db), now: () => Date.now() });
    await expect(other.seal(OWNER, 'conn0000002', { value: TOKEN })).rejects.toThrow('was made with local:');
  });
});
