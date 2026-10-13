import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { OwnerTickets } from '../src/agents/tickets.js';
import { completeSignIn, type ActionDeps } from '../src/connectors/actions.js';
import { credentialRevision } from '../src/connectors/delivery-model.js';
import { openConnectorSecret } from '../src/connectors/model.js';
import type { Handoff, SignInState } from '../src/connectors/sign-in.js';
import { agentKeyStore, leaveOrganization } from '../src/db/agent-keys.js';
import { agentNonceStore } from '../src/db/agent-nonces.js';
import { orgConnectorStore, type ConnectorRow } from '../src/db/connectors.js';
import { agents, agentNonces, connectors } from '../src/db/schema.js';
import { TEST_OWNER, TEST_STRANGER } from './identity-helper.js';
import { TEST_DATABASE_URL, postgresFixture } from './connector-postgres-fixture.js';
import { CONN, MASTER, PATH, assignConnector, enrollDeliveryAgent, latch, newDeliveryAgent, oauthSecret, opaque, openResponse, seedConnector, signedDelivery, startDeliveryApi, type DeliveryAgent } from './connector-delivery-fixture.js';

let held: Awaited<ReturnType<typeof postgresFixture>>;
let agent: DeliveryAgent;

async function signIn(row: ConnectorRow): Promise<unknown> {
  const secret = oauthSecret();
  const states = new OwnerTickets<SignInState>((value) => value.connector, { what: 'test sign-in' });
  const handoffs = new OwnerTickets<Handoff>((value) => value.connector, { what: 'test sign-in' });
  const deps: ActionDeps = {
    key: () => MASTER, store: orgConnectorStore(() => held.db2), states, handoffs, now: Date.now, httpsOnly: true, callbackUrl: 'https://api.metro.box/api/connectors/callback',
    fetch: (url) => Promise.resolve(url === secret.server.tokenEndpoint ? Response.json({ access_token: 'SIGNIN_ACCESS', refresh_token: 'SIGNIN_REFRESH', expires_in: 3600 }) : Response.json({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25', serverInfo: { name: 'Signed in' } } })),
  };
  const userId = 'user_01TEST';
  const { ticket } = handoffs.mint({ owner: TEST_OWNER, connector: row.id, generation: row.authGeneration ?? '', userId, verifier: 'verifier', code: 'code', returnTo: 'https://metro.box/', resource: secret.oauthResource ?? '', configuredResource: secret.oauthResource, targetUrl: secret.targetUrl, client: secret.client, server: secret.server }, Date.now());
  return completeSignIn(deps, { owner: TEST_OWNER, session: { userId, sessionId: 'session_test', organization: TEST_OWNER, role: 'admin', expiresAt: Date.now() + 60_000 } }, { handoff: ticket });
}

async function moved(): Promise<void> {
  await held.db2.transaction(async (tx) => {
    await tx.select().from(agents).where(eq(agents.id, agent.row.agent)).for('update');
    await leaveOrganization(tx, agent.row.agent);
    await tx.update(agents).set({ owner: TEST_STRANGER }).where(eq(agents.id, agent.row.agent));
  });
}

describe.skipIf(TEST_DATABASE_URL === undefined)('real Postgres connector delivery with independent pools', () => {
  beforeAll(async () => {
    if (TEST_DATABASE_URL === undefined) throw new Error('TEST_DATABASE_URL is required');
    held = await postgresFixture(TEST_DATABASE_URL);
  }, 30_000);
  beforeEach(async () => {
    await held.reset();
    agent = newDeliveryAgent();
    await enrollDeliveryAgent(held.db1, agent);
  });
  afterAll(async () => { await held?.close(); });

  test('simultaneous forced refreshes serialize on the row and use a rotating refresh token exactly once', async () => {
    const row = await seedConnector(held.db1, oauthSecret(Date.now() + 3600_000));
    await assignConnector(held.db1, agent);
    const hold = latch();
    const tokens: string[] = [];
    const fetchToken = async (_url: string, init?: RequestInit): Promise<Response> => {
      tokens.push(new URLSearchParams(String(init?.body)).get('refresh_token') ?? '');
      await hold.pause();
      return Response.json({ access_token: 'ROTATED_ACCESS', refresh_token: 'ROTATED_REFRESH', expires_in: 3600 });
    };
    const one = await startDeliveryApi(held.db1, { fetch: fetchToken });
    const two = await startDeliveryApi(held.db2, { fetch: fetchToken });
    try {
      const refresh = { connectorId: CONN, revision: credentialRevision(MASTER, row) };
      const firstId = opaque();
      const secondId = opaque();
      const first = one.call(agent, { requestId: firstId, refresh });
      await hold.reached;
      const second = two.call(agent, { requestId: secondId, refresh });
      await held.waiting('two');
      expect(tokens).toEqual(['REFRESH_OLD']);
      hold.release();
      const [a, b] = await Promise.all([first, second]);
      expect([a.status, b.status]).toEqual([200, 200]);
      const [left, right] = await Promise.all([openResponse(a, agent, firstId), openResponse(b, agent, secondId)]);
      expect(left.connectors[0]?.headers).toEqual({ Authorization: 'Bearer ROTATED_ACCESS' });
      expect(right.connectors[0]?.revision).toBe(left.connectors[0]?.revision);
      expect(tokens).toEqual(['REFRESH_OLD']);
      const stored = (await held.db1.select().from(connectors))[0];
      expect(stored).toBeDefined();
      if (stored !== undefined) {
        const secret = openConnectorSecret(MASTER, stored);
        expect(secret?.kind === 'oauth' ? secret.tokens?.refreshToken : undefined).toBe('ROTATED_REFRESH');
      }
    } finally { hold.release(); await one.close(); await two.close(); }
  }, 20_000);

  test('simultaneous expired-token polls also refresh once across processes', async () => {
    await seedConnector(held.db1, oauthSecret());
    await assignConnector(held.db1, agent);
    const hold = latch();
    let calls = 0;
    const fetchToken = async (): Promise<Response> => { calls += 1; await hold.pause(); return Response.json({ access_token: 'NEW', refresh_token: 'ROTATED', expires_in: 3600 }); };
    const one = await startDeliveryApi(held.db1, { fetch: fetchToken });
    const two = await startDeliveryApi(held.db2, { fetch: fetchToken });
    try {
      const first = one.call(agent);
      await hold.reached;
      const second = two.call(agent);
      await held.waiting('two');
      hold.release();
      expect((await Promise.all([first, second])).map((res) => res.status)).toEqual([200, 200]);
      expect(calls).toBe(1);
    } finally { hold.release(); await one.close(); await two.close(); }
  }, 20_000);

  test('a completed sign-in waiting on refresh wins before final sealing, never overwritten by old tokens', async () => {
    const row = await seedConnector(held.db1, oauthSecret());
    await assignConnector(held.db1, agent);
    const hold = latch();
    const one = await startDeliveryApi(held.db1, { fetch: async () => { await hold.pause(); return Response.json({ access_token: 'REFRESH_ACCESS', refresh_token: 'REFRESH_ROTATED', expires_in: 3600 }); } });
    try {
      const requestId = opaque();
      const pending = one.call(agent, { requestId });
      await hold.reached;
      const signin = signIn(row);
      await held.waiting('two');
      hold.release();
      await signin;
      const response = await pending;
      expect(response.status).toBe(200);
      expect((await openResponse(response, agent, requestId)).connectors[0]?.headers).toEqual({ Authorization: 'Bearer SIGNIN_ACCESS' });
      const current = (await held.db1.select().from(connectors))[0];
      if (current === undefined) throw new Error('missing connector');
      const secret = openConnectorSecret(MASTER, current);
      expect(secret?.kind === 'oauth' ? secret.tokens?.refreshToken : undefined).toBe('SIGNIN_REFRESH');
    } finally { hold.release(); await one.close(); }
  }, 20_000);

  for (const action of ['rekey', 'reseal-key', 'move', 'delete-agent'] as const) {
    test(`${action} during slow refresh prevents any sealed response to the old identity`, async () => {
      await seedConnector(held.db1, oauthSecret());
      await assignConnector(held.db1, agent);
      const hold = latch();
      const one = await startDeliveryApi(held.db1, { fetch: async () => { await hold.pause(); return Response.json({ access_token: 'NEW_ACCESS', refresh_token: 'NEW_REFRESH', expires_in: 3600 }); } });
      try {
        const pending = one.call(agent);
        await hold.reached;
        if (action === 'rekey') await agentKeyStore(() => held.db2).enroll(newDeliveryAgent().row);
        if (action === 'reseal-key') await agentKeyStore(() => held.db2).enroll({ ...agent.row, sealingKey: newDeliveryAgent().row.sealingKey });
        if (action === 'move') await moved();
        if (action === 'delete-agent') await held.db2.delete(agents).where(eq(agents.id, agent.row.agent));
        hold.release();
        const response = await pending;
        expect(response.status).toBe(401);
        expect(await response.text()).not.toContain('sealed');
        expect(await held.db1.$count(agentNonces)).toBe(1);
      } finally { hold.release(); await one.close(); }
    }, 20_000);
  }

  for (const action of ['unassign', 'delete-connector', 'deny-policy'] as const) {
    test(`${action} serialized behind refresh is rechecked before sealing`, async () => {
      await seedConnector(held.db1, oauthSecret());
      await assignConnector(held.db1, agent);
      const hold = latch();
      const one = await startDeliveryApi(held.db1, { fetch: async () => { await hold.pause(); return Response.json({ access_token: 'NEW_ACCESS', refresh_token: 'NEW_REFRESH', expires_in: 3600 }); } });
      try {
        const requestId = opaque();
        const pending = one.call(agent, { requestId });
        await hold.reached;
        const store = orgConnectorStore(() => held.db2);
        const at = new Date().toISOString();
        let edit: Promise<unknown>;
        if (action === 'unassign') edit = store.unassign({ owner: TEST_OWNER, connector: CONN, agent: agent.row.agent });
        else if (action === 'delete-connector') edit = store.remove(TEST_OWNER, CONN);
        else edit = store.edit(TEST_OWNER, CONN, at, () => ({ change: { policy: '{"read":"deny","write":"deny"}' } }));
        await held.waiting('two');
        hold.release();
        await edit;
        const response = await pending;
        expect(response.status).toBe(200);
        const opened = await openResponse(response, agent, requestId);
        if (action === 'deny-policy') expect(opened.connectors[0]).toMatchObject({ state: 'unavailable', headers: {}, policy: { read: 'deny', write: 'deny' } });
        else expect(opened.connectors).toEqual([]);
        expect(JSON.stringify(opened)).not.toContain('NEW_ACCESS');
      } finally { hold.release(); await one.close(); }
    }, 20_000);
  }

  test('a move holding the agent lock does not deadlock a connector-first final delivery', async () => {
    await seedConnector(held.db1, { kind: 'none', targetUrl: 'https://vendor.example/mcp' });
    await assignConnector(held.db1, agent);
    const hold = latch();
    const one = await startDeliveryApi(held.db1);
    try {
      const moving = held.db2.transaction(async (tx) => {
        await tx.select().from(agents).where(eq(agents.id, agent.row.agent)).for('update');
        await hold.pause();
        await leaveOrganization(tx, agent.row.agent);
        await tx.update(agents).set({ owner: TEST_STRANGER }).where(eq(agents.id, agent.row.agent));
      });
      await hold.reached;
      const delivery = one.call(agent);
      await held.waiting('one');
      hold.release();
      await moving;
      expect((await delivery).status).toBe(401);
    } finally { hold.release(); await one.close(); }
  }, 20_000);

  test('nonce budgets are atomic across independent pools', async () => {
    const limits = { total: 2, perOwner: 2, perKey: 1 };
    const one = await startDeliveryApi(held.db1, { nonces: agentNonceStore(() => held.db1, Date.now, limits) });
    const two = await startDeliveryApi(held.db2, { nonces: agentNonceStore(() => held.db2, Date.now, limits) });
    try {
      const responses = await Promise.all([one.call(agent), two.call(agent)]);
      expect(responses.map((res) => res.status).sort()).toEqual([200, 429]);
      expect(await held.db1.$count(agentNonces)).toBe(1);
    } finally { await one.close(); await two.close(); }
  }, 20_000);

  test('the same signed request is consumed exactly once across fresh auth instances and independent pools', async () => {
    const one = await startDeliveryApi(held.db1);
    const two = await startDeliveryApi(held.db2);
    const request = signedDelivery(agent, { requestId: opaque() });
    try {
      const responses = await Promise.all([fetch(`${one.base}${PATH}`, { method: 'POST', ...request }), fetch(`${two.base}${PATH}`, { method: 'POST', ...request })]);
      expect(responses.map((res) => res.status).sort()).toEqual([200, 401]);
      expect(await held.db1.$count(agentNonces)).toBe(1);
    } finally { await one.close(); await two.close(); }
    const restarted = await startDeliveryApi(held.db2);
    try { expect((await fetch(`${restarted.base}${PATH}`, { method: 'POST', ...request })).status).toBe(401); } finally { await restarted.close(); }
  }, 20_000);
});
