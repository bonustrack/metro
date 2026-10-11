import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, IncomingMessage, type Server } from 'node:http';
import { Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { boxKeyId, rawPublicKey, signBoxRequest } from '@metro-labs/http/box-signature';
import { BoxAuth } from '../src/boxes/auth.ts';
import { handleEnrollmentRequest, type EnrollmentDeps } from '../src/boxes/enrollment.ts';
import { EnrollTickets } from '../src/boxes/tickets.ts';
import { boxKeyStore, leaveOrganization } from '../src/db/boxes.ts';
import { agents, boxKeys, connectorAgents, connectorEvents, connectors } from '../src/db/schema.ts';
import { auth, bearer, testKeys, TEST_OWNER, TEST_STRANGER } from './identity-helper.ts';
import { addAgent, PGLITE_START_MS, PGLITE_STEP_MS, testDb, type TestDb } from './pglite-db.ts';
import { newBoxKey } from '../../daemon/src/connectors/box-key.ts';
import { boxCall } from '../../daemon/src/connectors/metro-api.ts';

const OURS = 'agent000001';
const SECOND = 'agent000002';
const THEIRS = 'agent000003';
const MINUTE = 60_000;

interface Box {
  signing: KeyObject;
  signingKey: string;
  sealingKey: string;
  keyId: string;
}

let held: TestDb;
let server: Server;
let base = '';
let host = '';
let enabled = true;
let now = Date.now();
let deps: EnrollmentDeps;

function newBox(): Box {
  const signing = generateKeyPairSync('ed25519');
  const signingKey = rawPublicKey(signing.publicKey);
  return { signing: signing.privateKey, signingKey, sealingKey: rawPublicKey(generateKeyPairSync('x25519').publicKey), keyId: boxKeyId(signingKey) };
}

const signedHeaders = (box: Box, method: string, path: string, text: string, at = now): Record<string, string> => ({
  authorization: signBoxRequest({ method, host, path, body: Buffer.from(text) }, box.signing, box.keyId, at),
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

function enroll(box: Box, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
  const text = JSON.stringify(body);
  return fetch(`${base}/api/boxes/enroll`, { method: 'POST', headers: { ...signedHeaders(box, 'POST', '/api/boxes/enroll', text), ...headers }, body: text });
}

const enrollBody = (box: Box, ticket: string, organization = TEST_OWNER): Record<string, unknown> => ({ ticket, organization, signingKey: box.signingKey, sealingKey: box.sealingKey });

const session = (box: Box, at = now): Promise<Response> => fetch(`${base}/api/boxes/session`, { headers: signedHeaders(box, 'GET', '/api/boxes/session', '', at) });

const errorOf = async (res: Response): Promise<string> => ((await res.json()) as { error: string }).error;

beforeAll(async () => {
  held = await testDb();
  deps = {
    enabled: () => enabled,
    keys: await testKeys(),
    tickets: new EnrollTickets(),
    store: boxKeyStore(() => held.db),
    auth: new BoxAuth('', () => now),
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
  enabled = true;
  now = Date.now();
  deps.tickets = new EnrollTickets();
  deps.auth = new BoxAuth(host, () => now);
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
    const box = newBox();
    const first = await ticketFor();
    const second = await ticketFor();
    expect((await enroll(box, enrollBody(box, first))).status).toBe(400);
    expect((await enroll(box, enrollBody(box, second))).status).toBe(200);
  });

  test('one organization cannot use up the tickets of the others', async () => {
    const owner = await auth(TEST_OWNER);
    for (let i = 0; i < 21; i += 1) await addAgent(held.db, `many${String(i).padStart(7, '0')}`, TEST_OWNER);
    for (let i = 0; i < 20; i += 1) expect((await mint(`many${String(i).padStart(7, '0')}`, owner)).status).toBe(200);
    expect((await mint('many0000020', owner)).status).toBe(429);
    expect((await mint(THEIRS, await auth(TEST_STRANGER))).status).toBe(200);
  }, PGLITE_STEP_MS);

  test('everything answers 503 while organization connectors are off', async () => {
    enabled = false;
    const box = newBox();
    expect((await mint(OURS)).status).toBe(503);
    expect((await enroll(box, enrollBody(box, 'x'.repeat(43)))).status).toBe(503);
    expect((await session(box)).status).toBe(503);
    expect(await held.db.select().from(boxKeys)).toEqual([]);
  });
});

describe('a box enrolling', () => {
  test('a signed enroll with a fresh ticket registers the box key and logs it', async () => {
    const box = newBox();
    const res = await enroll(box, enrollBody(box, await ticketFor()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ server: OURS, organization: TEST_OWNER, keyId: box.keyId });
    expect(await held.db.select().from(boxKeys)).toEqual([{ agent: OURS, owner: TEST_OWNER, keyId: box.keyId, signingKey: box.signingKey, sealingKey: box.sealingKey, enrolledBy: 'user_01ABC', enrolledAt: new Date(now).toISOString() }]);
    const events = await held.db.select().from(connectorEvents);
    expect(events.map((e) => [e.owner, e.agent, e.actor, e.action, e.detail])).toEqual([[TEST_OWNER, OURS, 'user:user_01ABC', 'box.enrolled', JSON.stringify({ keyId: box.keyId })]]);
    const who = await session(box);
    expect(who.status).toBe(200);
    expect(await who.json()).toMatchObject({ server: OURS, organization: TEST_OWNER, keyId: box.keyId });
  });

  test('a ticket works once', async () => {
    const box = newBox();
    const ticket = await ticketFor();
    expect((await enroll(box, enrollBody(box, ticket))).status).toBe(200);
    const again = await enroll(box, enrollBody(box, ticket));
    expect(again.status).toBe(400);
    expect(await errorOf(again)).toContain('stale');
  });

  test('a bad signature or another organization does not spend the ticket', async () => {
    const box = newBox();
    const ticket = await ticketFor();
    const text = JSON.stringify(enrollBody(box, ticket));
    const forged = newBox();
    const unsigned = await fetch(`${base}/api/boxes/enroll`, { method: 'POST', headers: { authorization: signBoxRequest({ method: 'POST', host, path: '/api/boxes/enroll', body: Buffer.from(text) }, forged.signing, box.keyId, now) }, body: text });
    expect(unsigned.status).toBe(401);
    expect((await enroll(box, enrollBody(box, ticket, TEST_STRANGER))).status).toBe(400);
    expect((await enroll(box, enrollBody(box, ticket))).status).toBe(200);
  });

  test('the body is checked field by field', async () => {
    const box = newBox();
    const ticket = await ticketFor();
    expect((await enroll(box, { ...enrollBody(box, ticket), extra: true })).status).toBe(400);
    expect((await enroll(box, { ...enrollBody(box, ticket), sealingKey: 'A'.repeat(43) })).status).toBe(400);
    expect((await enroll(box, { ...enrollBody(box, ticket), signingKey: 'short' })).status).toBe(400);
    expect((await enroll(box, { ...enrollBody(box, ticket), signingKey: newBox().signingKey })).status).toBe(401);
    expect((await enroll(box, enrollBody(box, ticket))).status).toBe(200);
  });

  test('a browser can never call the box routes, a server-side fetch can', async () => {
    const box = newBox();
    expect((await enroll(box, enrollBody(box, await ticketFor()), { origin: 'https://metro.box' })).status).toBe(403);
    expect((await enroll(box, enrollBody(box, await ticketFor()))).status).toBe(200);
    expect((await fetch(`${base}/api/boxes/session`, { headers: { ...signedHeaders(box, 'GET', '/api/boxes/session', ''), 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect((await fetch(`${base}/api/boxes/session`, { headers: { ...signedHeaders(box, 'GET', '/api/boxes/session', ''), 'sec-fetch-mode': 'cors' } })).status).toBe(200);
  });

  test('an agent removed between the ticket and the enroll cannot be enrolled', async () => {
    const box = newBox();
    const ticket = await ticketFor();
    await held.db.delete(agents).where(eq(agents.id, OURS));
    expect((await enroll(box, enrollBody(box, ticket))).status).toBe(404);
    expect(await held.db.select().from(boxKeys)).toEqual([]);
  });
});

describe('signed box requests', () => {
  test('a replayed request is refused', async () => {
    const box = newBox();
    expect((await enroll(box, enrollBody(box, await ticketFor()))).status).toBe(200);
    const headers = signedHeaders(box, 'GET', '/api/boxes/session', '');
    expect((await fetch(`${base}/api/boxes/session`, { headers })).status).toBe(200);
    expect((await fetch(`${base}/api/boxes/session`, { headers })).status).toBe(401);
  });

  test('a clock more than five minutes off is named', async () => {
    const box = newBox();
    expect((await enroll(box, enrollBody(box, await ticketFor()))).status).toBe(200);
    const late = await session(box, now - 6 * MINUTE);
    expect(late.status).toBe(401);
    expect(await errorOf(late)).toContain('clock');
    expect((await session(box, now + 4 * MINUTE)).status).toBe(200);
  });

  test('an unknown key, a deleted agent or a moved agent gets nothing', async () => {
    const box = newBox();
    expect((await session(box)).status).toBe(401);
    expect((await enroll(box, enrollBody(box, await ticketFor()))).status).toBe(200);
    await held.db.update(agents).set({ owner: TEST_STRANGER }).where(eq(agents.id, OURS));
    expect((await session(box)).status).toBe(401);
    await held.db.update(agents).set({ owner: TEST_OWNER }).where(eq(agents.id, OURS));
    expect((await session(box)).status).toBe(200);
    await held.db.delete(agents).where(eq(agents.id, OURS));
    expect((await session(box)).status).toBe(401);
  });

  test('enrolling again with a new key retires the old one', async () => {
    const first = newBox();
    const second = newBox();
    expect((await enroll(first, enrollBody(first, await ticketFor()))).status).toBe(200);
    expect((await enroll(second, enrollBody(second, await ticketFor()))).status).toBe(200);
    expect((await session(first)).status).toBe(401);
    expect((await session(second)).status).toBe(200);
    const events = await held.db.select().from(connectorEvents);
    expect(events.map((e) => e.detail)).toContain(JSON.stringify({ keyId: second.keyId, replaced: first.keyId }));
  });

  test('a box key enrolled as one agent cannot be enrolled as another', async () => {
    const box = newBox();
    expect((await enroll(box, enrollBody(box, await ticketFor(OURS)))).status).toBe(200);
    const again = await enroll(box, enrollBody(box, await ticketFor(SECOND)));
    expect(again.status).toBe(409);
    expect((await held.db.select().from(boxKeys)).map((row) => row.agent)).toEqual([OURS]);
    expect(await (await session(box)).json()).toMatchObject({ server: OURS });
  });

  test('a request signed for another host is refused, whatever Host it sends', async () => {
    const box = newBox();
    expect((await enroll(box, enrollBody(box, await ticketFor()))).status).toBe(200);
    const elsewhere = signBoxRequest({ method: 'GET', host: 'staging-api.example.com', path: '/api/boxes/session', body: Buffer.alloc(0) }, box.signing, box.keyId, now);
    expect((await fetch(`${base}/api/boxes/session`, { headers: { authorization: elsewhere } })).status).toBe(401);
  });

  test('a small-order signing key is refused, with the signature it can forge', async () => {
    const weak = Buffer.from('0100000000000000000000000000000000000000000000000000000000000000', 'hex').toString('base64url');
    const ticket = await ticketFor();
    const text = JSON.stringify({ ticket, organization: TEST_OWNER, signingKey: weak, sealingKey: newBox().sealingKey });
    const forged = `MetroBox ${boxKeyId(weak)}.${String(now)}.${'A'.repeat(22)}.${Buffer.concat([Buffer.from(weak, 'base64url'), Buffer.alloc(32)]).toString('base64url')}`;
    const res = await fetch(`${base}/api/boxes/enroll`, { method: 'POST', headers: { authorization: forged, 'content-type': 'application/json' }, body: text });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain('signing key');
    expect(await held.db.select().from(boxKeys)).toEqual([]);
  });

  test('an agent that moves leaves its box key and its assignments behind, and the old organization log says so', async () => {
    const box = newBox();
    expect((await enroll(box, enrollBody(box, await ticketFor()))).status).toBe(200);
    await held.db.insert(connectors).values({ id: 'conn0000001', owner: TEST_OWNER, name: 'Linear', url: 'https://vendor.example/mcp', auth: 'none', policy: null, secret: null, createdBy: 'user_01ABC', createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z' });
    await held.db.insert(connectorAgents).values({ connector: 'conn0000001', agent: OURS, policy: null, createdBy: 'user_01ABC', createdAt: '2026-10-09T00:00:00.000Z' });
    await held.db.transaction(async (tx) => {
      await tx.update(agents).set({ owner: TEST_STRANGER }).where(eq(agents.id, OURS));
      await leaveOrganization(tx, OURS, TEST_OWNER, '2026-10-10T00:00:00.000Z');
    });
    expect(await held.db.select().from(boxKeys)).toEqual([]);
    expect(await held.db.select().from(connectorAgents)).toEqual([]);
    const events = await held.db.select().from(connectorEvents);
    expect(events.map((e) => [e.owner, e.agent, e.actor, e.action])).toContainEqual([TEST_OWNER, OURS, 'metro', 'box.unenrolled']);
    await held.db.update(agents).set({ owner: TEST_OWNER }).where(eq(agents.id, OURS));
    expect((await session(box)).status).toBe(401);
  });

  test('a mint for another organization agent is refused even with a valid admin token', async () => {
    const res = await mint(OURS, await bearer({ org_id: TEST_STRANGER, role: 'admin' }));
    expect(res.status).toBe(404);
  });
});

describe('the daemon box client against this api', () => {
  test('a key from newBoxKey enrolls through boxCall and then opens a session', async () => {
    const key = newBoxKey();
    const api = { base, fetch: (url: string, init: RequestInit) => fetch(url, init), now: () => now };
    const enrolled = await boxCall(api, key, '/api/boxes/enroll', { ticket: await ticketFor(), organization: TEST_OWNER, signingKey: key.signingKey, sealingKey: key.sealingKey });
    expect(enrolled).toEqual({ server: OURS, organization: TEST_OWNER, keyId: key.keyId });
    expect(await boxCall(api, key, '/api/boxes/session')).toMatchObject({ server: OURS, organization: TEST_OWNER, keyId: key.keyId });
    await expect(boxCall(api, newBoxKey(), '/api/boxes/session')).rejects.toThrow('not enrolled');
  });
});

describe('the replay guard', () => {
  const signedRequest = (authorization: string): IncomingMessage => {
    const req = new IncomingMessage(new Socket());
    req.method = 'GET';
    req.url = '/api/boxes/session';
    req.headers = { authorization };
    return req;
  };

  test('one box or one organization cannot fill it for the others, and old nonces leave it', () => {
    let at = 1_791_590_000_000;
    const guard = new BoxAuth('api.metro.box', () => at, { total: 6, perOwner: 4, perKey: 2 });
    const boxes = [newBox(), newBox(), newBox(), newBox()];
    const send = (box: Box, owner: string): void => {
      const req = signedRequest(signBoxRequest({ method: 'GET', host: 'api.metro.box', path: '/api/boxes/session', body: Buffer.alloc(0) }, box.signing, box.keyId, at));
      guard.accept(req, Buffer.alloc(0), guard.proofOf(req), box.signingKey, owner);
    };
    const [a, b, c, d] = boxes as [Box, Box, Box, Box];
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
