import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, IncomingMessage, type Server } from 'node:http';
import { Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { agentKeyId, rawPublicKey, signAgentRequest } from '@metro-labs/http/agent-signature';
import { AgentAuth } from '@metro-labs/connectors/agent-auth';
import { handleEnrollmentRequest, type EnrollmentDeps } from '../src/agents/enrollment.ts';
import { EnrollTickets } from '../src/agents/tickets.ts';
import { agentKeyStore, leaveOrganization } from '@metro-labs/connectors/db/agent-keys';
import { agents, agentKeys, connectorAgents, connectors } from '../src/db/schema.ts';
import { auth, bearer, testKeys, TEST_OWNER, TEST_STRANGER } from './identity-helper.ts';
import { addAgent, PGLITE_START_MS, PGLITE_STEP_MS, testDb, type TestDb } from './pglite-db.ts';
import { newAgentKey } from '../../daemon/src/connectors/agent-key.ts';
import { agentCall } from '../../daemon/src/connectors/metro-api.ts';

const OURS = 'agent000001';
const SECOND = 'agent000002';
const THEIRS = 'agent000003';
const MINUTE = 60_000;

interface Agent {
  signing: KeyObject;
  signingKey: string;
  keyId: string;
}

let held: TestDb;
let server: Server;
let base = '';
let host = '';
let now = Date.now();
let deps: EnrollmentDeps;

function newAgent(): Agent {
  const signing = generateKeyPairSync('ed25519');
  const signingKey = rawPublicKey(signing.publicKey);
  return { signing: signing.privateKey, signingKey, keyId: agentKeyId(signingKey) };
}

const signedHeaders = (agent: Agent, method: string, path: string, text: string, at = now): Record<string, string> => ({
  authorization: signAgentRequest({ method, host, path, body: Buffer.from(text) }, agent.signing, agent.keyId, at),
  ...(text === '' ? {} : { 'content-type': 'application/json' }),
});

const mint = async (agent: string, authorization?: string): Promise<Response> => fetch(`${base}/api/servers/${agent}/enrollment`, {
  method: 'POST', headers: { authorization: authorization ?? await auth(TEST_OWNER) },
});

async function ticketFor(agent = OURS): Promise<string> {
  const res = await mint(agent);
  expect(res.status).toBe(200);
  return ((await res.json()) as { ticket: string }).ticket;
}

function enroll(agent: Agent, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
  const text = JSON.stringify(body);
  return fetch(`${base}/api/agents/enroll`, { method: 'POST', headers: { ...signedHeaders(agent, 'POST', '/api/agents/enroll', text), ...headers }, body: text });
}

const enrollBody = (agent: Agent, ticket: string, organization = TEST_OWNER): Record<string, unknown> => ({ ticket, organization, signingKey: agent.signingKey });

const oldSealingKey = (): string => rawPublicKey(generateKeyPairSync('x25519').publicKey);

const storedSealingKeys = async (): Promise<unknown[]> => (await held.client.query<{ sealing_key: string | null }>('SELECT sealing_key FROM agent_keys ORDER BY agent')).rows.map((row) => row.sealing_key);

const session = (agent: Agent, at = now): Promise<Response> => fetch(`${base}/api/agents/session`, { headers: signedHeaders(agent, 'GET', '/api/agents/session', '', at) });

const errorOf = async (res: Response): Promise<string> => ((await res.json()) as { error: string }).error;

beforeAll(async () => {
  held = await testDb();
  deps = {
    keys: await testKeys(),
    tickets: new EnrollTickets(),
    store: agentKeyStore(() => held.db),
    auth: new AgentAuth('', () => now),
    now: () => now,
  };
  server = createServer((req, res) => {
    if (!handleEnrollmentRequest(req, res, deps)) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  host = `127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  base = `http://${host}`;
}, PGLITE_START_MS);

beforeEach(async () => {
  now = Date.now();
  deps.tickets = new EnrollTickets();
  deps.auth = new AgentAuth(host, () => now);
  await held.reset();
  await addAgent(held.db, OURS, TEST_OWNER);
  await addAgent(held.db, SECOND, TEST_OWNER);
  await addAgent(held.db, THEIRS, TEST_STRANGER);
}, PGLITE_STEP_MS);

afterAll(async () => {
  server.close();
  await held.close();
});

describe('enrollment tickets', () => {
  test('only an admin of the agent organization gets one', async () => {
    expect((await fetch(`${base}/api/servers/${OURS}/enrollment`, { method: 'POST' })).status).toBe(401);
    expect((await mint(OURS, await auth(TEST_OWNER, 'member'))).status).toBe(403);
    expect((await mint(THEIRS)).status).toBe(404);
    expect((await mint('nosuchagent')).status).toBe(404);
    expect((await mint('bad id')).status).toBe(404);
    const res = await mint(OURS);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ticket: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as unknown, expiresAt: now + 10 * MINUTE });
  });

  test('an agent has one open ticket: a new one replaces the old', async () => {
    const agent = newAgent();
    const first = await ticketFor();
    const second = await ticketFor();
    expect((await enroll(agent, enrollBody(agent, first))).status).toBe(400);
    expect((await enroll(agent, enrollBody(agent, second))).status).toBe(200);
  });

  test('one organization cannot use up the tickets of the others', async () => {
    const owner = await auth(TEST_OWNER);
    for (let i = 0; i < 21; i += 1) await addAgent(held.db, `many${String(i).padStart(7, '0')}`, TEST_OWNER);
    for (let i = 0; i < 20; i += 1) expect((await mint(`many${String(i).padStart(7, '0')}`, owner)).status).toBe(200);
    expect((await mint('many0000020', owner)).status).toBe(429);
    expect((await mint(THEIRS, await auth(TEST_STRANGER))).status).toBe(200);
  }, PGLITE_STEP_MS);

});

describe('an agent enrolling', () => {
  test('a signed enroll with a fresh ticket registers the agent key', async () => {
    const agent = newAgent();
    const res = await enroll(agent, enrollBody(agent, await ticketFor()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ server: OURS, organization: TEST_OWNER, keyId: agent.keyId });
    expect(await held.db.select().from(agentKeys)).toEqual([{ agent: OURS, owner: TEST_OWNER, keyId: agent.keyId, signingKey: agent.signingKey, enrolledBy: 'user_01ABC', enrolledAt: new Date(now).toISOString(), mcpTokenHash: null }]);
    expect(await storedSealingKeys()).toEqual([null]);
    const who = await session(agent);
    expect(who.status).toBe(200);
    expect(await who.json()).toMatchObject({ server: OURS, organization: TEST_OWNER, keyId: agent.keyId });
  });

  test('an older daemon that still sends a sealing key enrolls, and the key is ignored', async () => {
    const agent = newAgent();
    const res = await enroll(agent, { ...enrollBody(agent, await ticketFor()), sealingKey: oldSealingKey() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ server: OURS, organization: TEST_OWNER, keyId: agent.keyId });
    expect(await storedSealingKeys()).toEqual([null]);
    for (const sealingKey of ['A'.repeat(43), '', 42, null]) {
      const next = newAgent();
      expect((await enroll(next, { ...enrollBody(next, await ticketFor(SECOND)), sealingKey })).status).toBe(200);
      expect((await session(next)).status).toBe(200);
    }
    expect(await storedSealingKeys()).toEqual([null, null]);
  });

  test('a ticket works once', async () => {
    const agent = newAgent();
    const ticket = await ticketFor();
    expect((await enroll(agent, enrollBody(agent, ticket))).status).toBe(200);
    const again = await enroll(agent, enrollBody(agent, ticket));
    expect(again.status).toBe(400);
    expect(await errorOf(again)).toContain('stale');
  });

  test('a bad signature or another organization does not spend the ticket', async () => {
    const agent = newAgent();
    const ticket = await ticketFor();
    const text = JSON.stringify(enrollBody(agent, ticket));
    const forged = newAgent();
    const unsigned = await fetch(`${base}/api/agents/enroll`, { method: 'POST', headers: { authorization: signAgentRequest({ method: 'POST', host, path: '/api/agents/enroll', body: Buffer.from(text) }, forged.signing, agent.keyId, now) }, body: text });
    expect(unsigned.status).toBe(401);
    expect((await enroll(agent, enrollBody(agent, ticket, TEST_STRANGER))).status).toBe(400);
    expect((await enroll(agent, enrollBody(agent, ticket))).status).toBe(200);
  });

  test('the body is checked field by field', async () => {
    const agent = newAgent();
    const ticket = await ticketFor();
    expect((await enroll(agent, { ...enrollBody(agent, ticket), extra: true })).status).toBe(400);
    expect((await enroll(agent, { ...enrollBody(agent, ticket), signingKey: 'short' })).status).toBe(400);
    expect((await enroll(agent, { ...enrollBody(agent, ticket), signingKey: newAgent().signingKey })).status).toBe(401);
    expect((await enroll(agent, enrollBody(agent, ticket))).status).toBe(200);
  });

  test('a browser can never call the agent routes, a server-side fetch can', async () => {
    const agent = newAgent();
    expect((await enroll(agent, enrollBody(agent, await ticketFor()), { origin: 'https://metro.box' })).status).toBe(403);
    expect((await enroll(agent, enrollBody(agent, await ticketFor()))).status).toBe(200);
    expect((await fetch(`${base}/api/agents/session`, { headers: { ...signedHeaders(agent, 'GET', '/api/agents/session', ''), 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect((await fetch(`${base}/api/agents/session`, { headers: { ...signedHeaders(agent, 'GET', '/api/agents/session', ''), 'sec-fetch-mode': 'cors' } })).status).toBe(200);
  });

  test('an agent removed between the ticket and the enroll cannot be enrolled', async () => {
    const agent = newAgent();
    const ticket = await ticketFor();
    await held.db.delete(agents).where(eq(agents.id, OURS));
    expect((await enroll(agent, enrollBody(agent, ticket))).status).toBe(404);
    expect(await held.db.select().from(agentKeys)).toEqual([]);
  });
});

describe('signed agent requests', () => {
  test('a replayed request is refused', async () => {
    const agent = newAgent();
    expect((await enroll(agent, enrollBody(agent, await ticketFor()))).status).toBe(200);
    const headers = signedHeaders(agent, 'GET', '/api/agents/session', '');
    expect((await fetch(`${base}/api/agents/session`, { headers })).status).toBe(200);
    expect((await fetch(`${base}/api/agents/session`, { headers })).status).toBe(401);
  });

  test('a clock more than five minutes off is named', async () => {
    const agent = newAgent();
    expect((await enroll(agent, enrollBody(agent, await ticketFor()))).status).toBe(200);
    const late = await session(agent, now - 6 * MINUTE);
    expect(late.status).toBe(401);
    expect(await errorOf(late)).toContain('clock');
    expect((await session(agent, now + 4 * MINUTE)).status).toBe(200);
  });

  test('an unknown key, a deleted agent or a moved agent gets nothing', async () => {
    const agent = newAgent();
    expect((await session(agent)).status).toBe(401);
    expect((await enroll(agent, enrollBody(agent, await ticketFor()))).status).toBe(200);
    await held.db.update(agents).set({ owner: TEST_STRANGER }).where(eq(agents.id, OURS));
    expect((await session(agent)).status).toBe(401);
    await held.db.update(agents).set({ owner: TEST_OWNER }).where(eq(agents.id, OURS));
    expect((await session(agent)).status).toBe(200);
    await held.db.delete(agents).where(eq(agents.id, OURS));
    expect((await session(agent)).status).toBe(401);
  });

  test('enrolling again with a new key retires the old one', async () => {
    const first = newAgent();
    const second = newAgent();
    expect((await enroll(first, enrollBody(first, await ticketFor()))).status).toBe(200);
    expect((await enroll(second, enrollBody(second, await ticketFor()))).status).toBe(200);
    expect((await session(first)).status).toBe(401);
    expect((await session(second)).status).toBe(200);
  });

  test('an agent key enrolled as one agent cannot be enrolled as another', async () => {
    const agent = newAgent();
    expect((await enroll(agent, enrollBody(agent, await ticketFor(OURS)))).status).toBe(200);
    const again = await enroll(agent, enrollBody(agent, await ticketFor(SECOND)));
    expect(again.status).toBe(409);
    expect((await held.db.select().from(agentKeys)).map((row) => row.agent)).toEqual([OURS]);
    expect(await (await session(agent)).json()).toMatchObject({ server: OURS });
  });

  test('a request signed for another host is refused, whatever Host it sends', async () => {
    const agent = newAgent();
    expect((await enroll(agent, enrollBody(agent, await ticketFor()))).status).toBe(200);
    const elsewhere = signAgentRequest({ method: 'GET', host: 'staging-api.example.com', path: '/api/agents/session', body: Buffer.alloc(0) }, agent.signing, agent.keyId, now);
    expect((await fetch(`${base}/api/agents/session`, { headers: { authorization: elsewhere } })).status).toBe(401);
  });

  test('a small-order signing key is refused, with the signature it can forge', async () => {
    const weak = Buffer.from('0100000000000000000000000000000000000000000000000000000000000000', 'hex').toString('base64url');
    const ticket = await ticketFor();
    const text = JSON.stringify({ ticket, organization: TEST_OWNER, signingKey: weak });
    const forged = `MetroAgent ${agentKeyId(weak)}.${String(now)}.${'A'.repeat(22)}.${Buffer.concat([Buffer.from(weak, 'base64url'), Buffer.alloc(32)]).toString('base64url')}`;
    const res = await fetch(`${base}/api/agents/enroll`, { method: 'POST', headers: { authorization: forged, 'content-type': 'application/json' }, body: text });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain('signing key');
    expect(await held.db.select().from(agentKeys)).toEqual([]);
  });

  test('an agent that moves loses its agent key and its assignments', async () => {
    const agent = newAgent();
    expect((await enroll(agent, enrollBody(agent, await ticketFor()))).status).toBe(200);
    await held.db.insert(connectors).values({ id: 'conn0000001', owner: TEST_OWNER, name: 'Linear', url: 'https://vendor.example/mcp', auth: 'none', policy: null, secret: null, createdBy: 'user_01ABC', createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z' });
    await held.db.insert(connectorAgents).values({ connector: 'conn0000001', agent: OURS, policy: null, createdBy: 'user_01ABC', createdAt: '2026-10-09T00:00:00.000Z' });
    await held.db.transaction(async (tx) => {
      await tx.update(agents).set({ owner: TEST_STRANGER }).where(eq(agents.id, OURS));
      await leaveOrganization(tx, OURS);
    });
    expect(await held.db.select().from(agentKeys)).toEqual([]);
    expect(await held.db.select().from(connectorAgents)).toEqual([]);
    await held.db.update(agents).set({ owner: TEST_OWNER }).where(eq(agents.id, OURS));
    expect((await session(agent)).status).toBe(401);
  });

  test('a mint for another organization agent is refused even with a valid admin token', async () => {
    const res = await mint(OURS, await bearer({ org_id: TEST_STRANGER, role: 'admin' }));
    expect(res.status).toBe(404);
  });
});

describe('the daemon agent client against this api', () => {
  test('old connector routes and the old signature scheme are not accepted', async () => {
    const agent = newAgent();
    expect((await fetch(`${base}/api/boxes/enroll`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${base}/api/boxes/session`)).status).toBe(404);
    const body = enrollBody(agent, await ticketFor());
    const headers = signedHeaders(agent, 'POST', '/api/agents/enroll', JSON.stringify(body));
    expect((await enroll(agent, body, { authorization: (headers.authorization ?? '').replace('MetroAgent', 'MetroBox') })).status).toBe(401);
    expect((await enroll(agent, body)).status).toBe(200);
  });

  test('a key from newAgentKey enrolls through agentCall and then opens a session', async () => {
    const key = newAgentKey();
    const api = { base, fetch: (url: string, init: RequestInit) => fetch(url, init), now: () => now };
    const enrolled = await agentCall(api, key, '/api/agents/enroll', { ticket: await ticketFor(), organization: TEST_OWNER, signingKey: key.signingKey });
    expect(enrolled).toEqual({ server: OURS, organization: TEST_OWNER, keyId: key.keyId });
    expect(await agentCall(api, key, '/api/agents/session')).toMatchObject({ server: OURS, organization: TEST_OWNER, keyId: key.keyId });
    await expect(agentCall(api, newAgentKey(), '/api/agents/session')).rejects.toThrow('not enrolled');
  });
});

describe('the replay guard', () => {
  const signedRequest = (authorization: string): IncomingMessage => {
    const req = new IncomingMessage(new Socket());
    req.method = 'GET';
    req.url = '/api/agents/session';
    req.headers = { authorization };
    return req;
  };

  test('one agent or one organization cannot fill it for the others, and old nonces leave it', () => {
    let at = 1_791_590_000_000;
    const guard = new AgentAuth('api.metro.box', () => at, { total: 6, perOwner: 4, perKey: 2 });
    const agents = [newAgent(), newAgent(), newAgent(), newAgent()];
    const send = (agent: Agent, owner: string): void => {
      const req = signedRequest(signAgentRequest({ method: 'GET', host: 'api.metro.box', path: '/api/agents/session', body: Buffer.alloc(0) }, agent.signing, agent.keyId, at));
      guard.accept(req, Buffer.alloc(0), guard.proofOf(req), agent.signingKey, owner);
    };
    const [a, b, c, d] = agents as [Agent, Agent, Agent, Agent];
    send(a, TEST_OWNER);
    send(a, TEST_OWNER);
    expect(() => { send(a, TEST_OWNER); }).toThrow('too many requests');
    send(b, TEST_OWNER);
    send(b, TEST_OWNER);
    expect(() => { send(c, TEST_OWNER); }).toThrow('organization sent too many');
    send(c, TEST_STRANGER);
    send(d, TEST_STRANGER);
    expect(() => { send(d, 'org_01THIRDORG00000'); }).toThrow('busy');
    at += 6 * MINUTE;
    expect(() => { send(a, TEST_OWNER); }).not.toThrow();
  });
});
