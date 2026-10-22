import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { MCP_APPROVAL_ID_RE } from '@metro-labs/http/mcp-server-protocol';
import { agents, mcpApprovals } from '@metro-labs/connectors/db/schema';
import { APPROVAL_TTL_MS, GRANT_WINDOW_MS, PENDING_MAX, REDELIVER_MS, approvalStore, type ApprovalRequest, type ApprovalStore } from '@metro-labs/connectors/db/mcp-approvals';
import { argsDigest, canonicalJson, PREVIEW_MAX, previewOf } from '../src/digest.ts';
import { createAgentToken } from '@metro-labs/connectors/db/agent-tokens';
import { enrollAgent, PGLITE_START_MS, testDb, type TestAgent, type TestDb } from './helpers.ts';

let held: TestDb;
let store: ApprovalStore;
let agent: TestAgent;
let other: TestAgent;
const T0 = Date.parse('2026-10-14T10:00:00.000Z');
const BEFORE_ORIGIN = 19;

const call = (args: Record<string, unknown>, tool = 'update_page', connector = 'conn0000001'): ApprovalRequest => ({ connector, tool, digest: argsDigest(args), preview: previewOf(args) });
const stateOf = async (id: string): Promise<string | undefined> => (await held.db.select().from(mcpApprovals).where(eq(mcpApprovals.id, id)))[0]?.state;

beforeAll(async () => { held = await testDb(); store = approvalStore(() => held.db); }, PGLITE_START_MS);
beforeEach(async () => {
  await held.reset();
  agent = await enrollAgent(held.db, 'agent000001');
  other = await enrollAgent(held.db, 'agent000002');
});
afterAll(async () => { await held.close(); });

describe('argument digests and previews', () => {
  test('the digest is over canonical JSON, so key order does not matter', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
    expect(argsDigest({ a: 1, b: 2 })).toBe(argsDigest({ b: 2, a: 1 }));
    expect(argsDigest({ a: 1 })).not.toBe(argsDigest({ a: 2 }));
    expect(argsDigest({})).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('a preview is cut at 1,000 characters', () => {
    expect(previewOf({ text: 'x'.repeat(5000) })).toHaveLength(PREVIEW_MAX);
    expect(previewOf({ text: 'hi' })).toBe('{"text":"hi"}');
  });
});

describe('the approval state machine', () => {
  test('an Ask call makes one pending row, and the same call reuses its id', async () => {
    const id = await store.request(agent.row, call({ page: 1 }), T0);
    expect(id).toMatch(MCP_APPROVAL_ID_RE);
    expect(await store.request(agent.row, call({ page: 1 }), T0 + 1000)).toBe(id);
    expect(await store.request(agent.row, call({ page: 2 }), T0)).not.toBe(id);
    expect(await store.request(other.row, call({ page: 1 }), T0)).not.toBe(id);
    expect(await held.db.$count(mcpApprovals)).toBe(3);
  });

  test('an allowed approval runs once, for exactly that call', async () => {
    const id = await store.request(agent.row, call({ page: 1 }), T0);
    expect(await store.redeem(agent.row, id, call({ page: 1 }), T0)).toBe('invalid');
    expect(await store.answer(agent.row, id, 'allow', T0 + 1000)).toBe(true);
    expect(await store.redeem(agent.row, id, call({ page: 2 }), T0 + 2000)).toBe('invalid');
    expect(await store.redeem(agent.row, id, call({ page: 1 }, 'delete_page'), T0 + 2000)).toBe('invalid');
    expect(await store.redeem(agent.row, id, call({ page: 1 }, 'update_page', 'conn0000002'), T0 + 2000)).toBe('invalid');
    expect(await store.redeem(other.row, id, call({ page: 1 }), T0 + 2000)).toBe('invalid');
    expect(await store.redeem(agent.row, id, call({ page: 1 }), T0 + 2000)).toBe('used');
    expect(await store.redeem(agent.row, id, call({ page: 1 }), T0 + 3000)).toBe('invalid');
    expect(await stateOf(id)).toBe('used');
  });

  test('an approval works only within 10 minutes of the answer', async () => {
    const id = await store.request(agent.row, call({ page: 1 }), T0);
    await store.answer(agent.row, id, 'allow', T0);
    expect(await store.redeem(agent.row, id, call({ page: 1 }), T0 + GRANT_WINDOW_MS + 1)).toBe('invalid');
    expect(await store.redeem(agent.row, id, call({ page: 1 }), T0 + GRANT_WINDOW_MS)).toBe('used');
  });

  test('a denied approval says so for the same call', async () => {
    const id = await store.request(agent.row, call({ page: 1 }), T0);
    expect(await store.answer(agent.row, id, 'deny', T0)).toBe(true);
    expect(await store.redeem(agent.row, id, call({ page: 1 }), T0)).toBe('denied');
    expect(await store.redeem(agent.row, id, call({ page: 2 }), T0)).toBe('invalid');
  });

  test('only the agent\'s own pending row can be answered, once', async () => {
    const id = await store.request(agent.row, call({ page: 1 }), T0);
    expect(await store.answer(other.row, id, 'allow', T0)).toBe(false);
    expect(await store.answer(agent.row, 'zzzzz', 'allow', T0)).toBe(false);
    expect(await store.answer(agent.row, id, 'allow', T0)).toBe(true);
    expect(await store.answer(agent.row, id, 'deny', T0)).toBe(false);
  });

  test('a request unanswered for 24 hours expires and cannot be answered', async () => {
    const id = await store.request(agent.row, call({ page: 1 }), T0);
    expect(await store.answer(agent.row, id, 'allow', T0 + APPROVAL_TTL_MS + 1)).toBe(false);
    expect(await stateOf(id)).toBe('expired');
    const fresh = await store.request(agent.row, call({ page: 1 }), T0 + APPROVAL_TTL_MS + 2);
    expect(fresh).not.toBe(id);
  });

  test('pending rows are delivered once, then again after a minute while still pending', async () => {
    const first = await store.request(agent.row, call({ page: 1 }), T0);
    const second = await store.request(agent.row, call({ page: 2 }), T0 + 1);
    await store.request(other.row, call({ page: 1 }), T0);
    expect((await store.deliver(agent.row, T0 + 10)).map((row) => row.id)).toEqual([first, second]);
    expect(await store.deliver(agent.row, T0 + 20)).toEqual([]);
    await store.answer(agent.row, first, 'allow', T0 + 30);
    expect((await store.deliver(agent.row, T0 + 10 + REDELIVER_MS + 1)).map((row) => row.id)).toEqual([second]);
  });

  test('an agent cannot pile up more than the pending limit', async () => {
    for (let i = 0; i < PENDING_MAX; i += 1) await store.request(agent.row, call({ i }), T0);
    await expect(store.request(agent.row, call({ i: 'one more' }), T0)).rejects.toThrow('already waiting');
  });

  test('approvals go with their agent', async () => {
    await store.request(agent.row, call({ page: 1 }), T0);
    await held.db.delete(agents).where(eq(agents.id, agent.row.agent));
    expect(await held.db.$count(mcpApprovals)).toBe(0);
  });

  test('the agent\'s session and each access key get their own request for the same call, and delivery names the key', async () => {
    const laptop = await createAgentToken(held.db, { owner: agent.row.owner, agent: agent.row.agent, label: 'Laptop', createdBy: 'user_01TEST', now: T0 });
    const phone = await createAgentToken(held.db, { owner: agent.row.owner, agent: agent.row.agent, label: 'Phone', createdBy: 'user_01TEST', now: T0 });
    const own = await store.request(agent.row, call({ page: 1 }), T0);
    const byLaptop = await store.request(agent.row, { ...call({ page: 1 }), token: laptop.row.id }, T0 + 1);
    const byPhone = await store.request(agent.row, { ...call({ page: 1 }), token: phone.row.id }, T0 + 2);
    expect(new Set([own, byLaptop, byPhone]).size).toBe(3);
    expect(await store.request(agent.row, call({ page: 1 }), T0 + 3)).toBe(own);
    expect(await store.request(agent.row, { ...call({ page: 1 }), token: laptop.row.id }, T0 + 3)).toBe(byLaptop);
    const delivered = await store.deliver(agent.row, T0 + 10);
    expect(delivered.map((row) => [row.id, row.origin, row.token, row.keyLabel])).toEqual([[own, 'box', null, null], [byLaptop, 'key', laptop.row.id, 'Laptop'], [byPhone, 'key', phone.row.id, 'Phone']]);
    await store.answer(agent.row, byLaptop, 'allow', T0 + 20);
    expect(await store.redeem(agent.row, byLaptop, call({ page: 1 }), T0 + 30)).toBe('used');
  });

  test('the database refuses an origin it does not know, a key without its id, and a box with one', async () => {
    const id = await store.request(agent.row, call({ page: 1 }), T0);
    for (const bad of [{ origin: 'remote', token: null }, { origin: 'key', token: null }, { origin: 'box', token: 'tok00000001' }, { origin: null, token: 'tok00000001' }])
      await expect(held.db.update(mcpApprovals).set(bad).where(eq(mcpApprovals.id, id)).execute()).rejects.toThrow();
  });
});

describe('before api.metro.box adds the origin column', () => {
  let early: TestDb;
  let early1: TestAgent;

  beforeAll(async () => {
    early = await testDb(BEFORE_ORIGIN);
    early1 = await enrollAgent(early.db, 'agent000009');
  }, PGLITE_START_MS);
  afterAll(async () => { await early.close(); });

  test('requests and deliveries keep working without who made the call, and pick it up once the migration runs', async () => {
    const earlyStore = approvalStore(() => early.db);
    const laptop = await createAgentToken(early.db, { owner: early1.row.owner, agent: early1.row.agent, label: 'Laptop', createdBy: 'user_01TEST', now: T0 });
    const old = await earlyStore.request(early1.row, call({ page: 1 }), T0);
    expect(await earlyStore.request(early1.row, { ...call({ page: 1 }), token: laptop.row.id }, T0 + 1)).toBe(old);
    expect((await earlyStore.deliver(early1.row, T0 + 10)).map((row) => [row.id, row.origin, row.token, row.keyLabel])).toEqual([[old, null, null, null]]);
    expect(await earlyStore.answer(early1.row, old, 'allow', T0 + 20)).toBe(true);
    expect(await earlyStore.redeem(early1.row, old, call({ page: 1 }), T0 + 30)).toBe('used');

    await early.migrateAll();
    const waiting = await earlyStore.request(early1.row, call({ page: 2 }), T0 + 40);
    const keyed = await earlyStore.request(early1.row, { ...call({ page: 2 }), token: laptop.row.id }, T0 + 41);
    expect(keyed).not.toBe(waiting);
    expect((await earlyStore.deliver(early1.row, T0 + 50)).map((row) => [row.id, row.origin, row.keyLabel])).toEqual([[waiting, 'box', null], [keyed, 'key', 'Laptop']]);
  });
});
