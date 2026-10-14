import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { MCP_APPROVAL_ID_RE } from '@metro-labs/http/mcp-server-protocol';
import { agents, mcpApprovals } from '@metro-labs/connectors/db/schema';
import { APPROVAL_TTL_MS, GRANT_WINDOW_MS, PENDING_MAX, REDELIVER_MS, approvalStore, type ApprovalRequest, type ApprovalStore } from '../src/approvals.ts';
import { argsDigest, canonicalJson, PREVIEW_MAX, previewOf } from '../src/digest.ts';
import { enrollAgent, PGLITE_START_MS, testDb, type TestAgent, type TestDb } from './helpers.ts';

let held: TestDb;
let store: ApprovalStore;
let agent: TestAgent;
let other: TestAgent;
const T0 = Date.parse('2026-10-14T10:00:00.000Z');

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
});
