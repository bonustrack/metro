import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { generateKeyPairSync, randomBytes, randomInt, type KeyObject } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { log } from '@metro-labs/core/log';
import { readBodyBytes, setBearerSessions } from '@metro-labs/http/api-http';
import { agentKeyId, agentSignatureValid, rawPublicKey, readAgentProof } from '@metro-labs/http/agent-signature';
import { SigningKeys } from '@metro-labs/http/workos-token';
import { fakeIssuer, sessionClaims, type FakeIssuer } from '../../../packages/http/test/workos-fixture.ts';
import { bearerSessionsFor } from '../src/routes/bearer.ts';
import { handleSessionApis } from '../src/routes/session-apis.ts';
import { newAgentKey, readAgentKey, readPendingAgentKey, saveAgentKey } from '../src/connectors/agent-key.ts';
import { viewFiles } from '../src/agent-user/view.ts';

const OWNER = 'org_01AGENTOWNER00000';
const SERVER = 'agent000001';
const TICKET = 'T'.repeat(43);

interface Seen {
  path: string;
  body: Record<string, unknown>;
}

let issuer: FakeIssuer;
let root = '';
let dir = '';
let agentBase = '';
let apiBase = '';
let deviceOwner: string | null = OWNER;
let seen: Seen[] = [];
let enrolledKey: string | null = null;
let enrolledServer = SERVER;
let tickets = new Map([[TICKET, SERVER]]);
const issueTicket = (server = SERVER): string => {
  const ticket = randomBytes(32).toString('base64url');
  tickets.set(ticket, server);
  return ticket;
};
let reply: ((path: string) => { status: number; body: unknown } | null) | null = null;
let beforeReply: ((path: string) => Promise<void>) | null = null;
let loseEnrollmentAnswer = false;
const servers: Server[] = [];

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  const port = randomInt(10000, 30000);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  servers.push(server);
  return `http://127.0.0.1:${String(port)}`;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function fakeApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const bytes = await readBodyBytes(req, 4096);
  const path = req.url ?? '';
  const body = bytes.length === 0 ? {} : JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  seen.push({ path, body });
  const proof = readAgentProof(req.headers.authorization);
  const signingKey = path === '/api/agents/enroll' ? String(body.signingKey) : enrolledKey;
  const request = { method: req.method ?? '', host: req.headers.host ?? '', path, body: bytes };
  if (proof === null || signingKey === null || !agentSignatureValid(request, proof, signingKey)) {
    send(res, 401, { error: 'This agent is not enrolled with Metro, or its request signature is not valid.', code: 'agent_key_missing' });
    return;
  }
  await beforeReply?.(path);
  const custom = reply?.(path) ?? null;
  if (custom !== null) {
    send(res, custom.status, custom.body);
    return;
  }
  if (path === '/api/agents/enroll') {
    const ticket = String(body.ticket);
    const server = tickets.get(ticket);
    if (server === undefined) {
      send(res, 400, { error: 'This enrollment ticket is stale.' });
      return;
    }
    tickets.delete(ticket);
    enrolledKey = signingKey;
    enrolledServer = server;
    if (loseEnrollmentAnswer) throw new Error('answer lost after commit');
  }
  send(res, 200, { server: enrolledServer, organization: OWNER, keyId: agentKeyId(signingKey), enrolledAt: '2026-10-09T00:00:00.000Z' });
}

const enroll = (body: unknown, role = 'admin'): Promise<Response> => fetch(`${agentBase}/api/enrollment`, {
  method: 'POST',
  headers: { authorization: `Bearer ${issuer.mint(sessionClaims({ org_id: OWNER, role }))}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const storedEnrollment = (): unknown => (JSON.parse(readFileSync(join(dir, 'agent-key.json'), 'utf8')) as { enrollment?: unknown }).enrollment;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'metro-enrollment-'));
  issuer = await fakeIssuer();
  const keys = new SigningKeys(issuer.url);
  apiBase = await listen((req, res) => {
    fakeApi(req, res).catch(() => {
      send(res, 500, { error: 'fake api failed' });
    });
  });
  agentBase = await listen((req, res) => {
    setBearerSessions(bearerSessionsFor(() => OWNER, keys));
    const api = { base: apiBase, fetch: (url: string, init: RequestInit) => fetch(url, init), now: () => Date.now() };
    if (!handleSessionApis(req, res, { enrollApi: { owner: () => deviceOwner, dir: () => dir, api } })) res.writeHead(404).end();
  });
});

beforeEach(() => {
  dir = mkdtempSync(join(root, 'agents-'));
  deviceOwner = OWNER;
  seen = [];
  enrolledKey = null;
  enrolledServer = SERVER;
  tickets = new Map([[TICKET, SERVER]]);
  reply = null;
  beforeReply = null;
  loseEnrollmentAnswer = false;
});

afterAll(async () => {
  setBearerSessions(null);
  for (const server of servers) await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  await issuer.close();
  rmSync(root, { recursive: true, force: true });
});

const ENROLLED = { server: SERVER, organization: OWNER, at: '2026-10-09T00:00:00.000Z' };

describe('the agent key', () => {
  test('is made in memory, saved 0600 in Metro folder with its enrollment, and read back the same', () => {
    expect(readAgentKey(dir)).toBeNull();
    const made = newAgentKey();
    expect(made.keyId).toBe(agentKeyId(made.signingKey));
    expect(existsSync(join(dir, 'agent-key.json'))).toBe(false);
    saveAgentKey(made, ENROLLED, dir);
    expect(statSync(join(dir, 'agent-key.json')).mode & 0o777).toBe(0o600);
    const back = readAgentKey(dir);
    expect(back?.keyId).toBe(made.keyId);
    expect(back?.enrollment).toEqual(ENROLLED);
    expect(Object.keys(JSON.parse(readFileSync(join(dir, 'agent-key.json'), 'utf8')) as Record<string, unknown>).sort()).toEqual(['enrollment', 'signing', 'version']);
    expect(newAgentKey().keyId).not.toBe(made.keyId);
  });

  test('a legacy key keeps its private key and enrollment, and a new file takes precedence', () => {
    const old = newAgentKey();
    saveAgentKey(old, ENROLLED, dir);
    renameSync(join(dir, 'agent-key.json'), join(dir, 'box-key.json'));
    const bytes = readFileSync(join(dir, 'box-key.json'), 'utf8');
    const kept = readAgentKey(dir);
    expect(kept?.keyId).toBe(old.keyId);
    expect(kept?.signing.export({ type: 'pkcs8', format: 'der' })).toEqual(old.signing.export({ type: 'pkcs8', format: 'der' }));
    expect(kept?.enrollment).toEqual(ENROLLED);
    expect(readFileSync(join(dir, 'box-key.json'), 'utf8')).toBe(bytes);
    const next = newAgentKey();
    saveAgentKey(next, ENROLLED, dir);
    expect(readAgentKey(dir)?.keyId).toBe(next.keyId);
    writeFileSync(join(dir, 'agent-key.json'), '{}');
    expect(readAgentKey(dir)).toBeNull();
    expect(viewFiles(dir).has('box-key.json')).toBe(false);
    expect(viewFiles(dir).has('agent-key.json')).toBe(false);
  });

  test('a damaged file reads as no key, and its content never reaches the log', () => {
    const warnings = spyOn(log, 'warn');
    writeFileSync(join(dir, 'agent-key.json'), '{"version":1,"signing":MC4CAQAwBQYDK2VwBCIEIDamaged');
    expect(readAgentKey(dir)).toBeNull();
    writeFileSync(join(dir, 'agent-key.json'), JSON.stringify({ version: 1, signing: 'bm90IGEga2V5', sealing: 'bm90IGEga2V5' }));
    expect(readAgentKey(dir)).toBeNull();
    expect(warnings).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warnings.mock.calls)).not.toContain('MC4CAQ');
    warnings.mockRestore();
  });

  test('a file an older daemon wrote with a sealing key still loads, and the next save drops that key', () => {
    const signing = generateKeyPairSync('ed25519');
    const der = (key: KeyObject): string => key.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    const keyId = agentKeyId(rawPublicKey(signing.publicKey));
    for (const sealing of [der(generateKeyPairSync('x25519').privateKey), 'bm90IGEga2V5', 42]) {
      writeFileSync(join(dir, 'agent-key.json'), JSON.stringify({ version: 1, signing: der(signing.privateKey), sealing, enrollment: ENROLLED }));
      const read = readAgentKey(dir);
      expect(read?.keyId).toBe(keyId);
      expect(read?.enrollment).toEqual(ENROLLED);
      writeFileSync(join(dir, 'agent-key.pending.json'), JSON.stringify({ version: 1, signing: der(signing.privateKey), sealing, owner: OWNER, ticketHash: 'h'.repeat(43) }));
      expect(readPendingAgentKey(OWNER, dir)?.keyId).toBe(keyId);
    }
    const kept = readAgentKey(dir);
    if (kept === null) throw new Error('the old key did not load');
    saveAgentKey(kept, ENROLLED, dir);
    const saved = JSON.parse(readFileSync(join(dir, 'agent-key.json'), 'utf8')) as Record<string, unknown>;
    expect(saved.sealing).toBeUndefined();
    expect(saved.signing).toBe(der(signing.privateKey));
    expect(readAgentKey(dir)?.keyId).toBe(keyId);
  });

  test('never reaches the agent view', () => {
    saveAgentKey(newAgentKey(), ENROLLED, dir);
    const files = viewFiles(dir);
    expect(files.has('agent-key.json')).toBe(false);
    expect([...files.values()].join('\n')).not.toContain(readFileSync(join(dir, 'agent-key.json'), 'utf8').slice(0, 60));
  });
});

describe('POST /api/enrollment', () => {
  test('an admin enrolls the agent: signed enroll, signed session, then the enrollment is saved', async () => {
    const res = await enroll({ ticket: TICKET });
    expect(res.status).toBe(200);
    const key = readAgentKey(dir);
    expect(await res.json()).toEqual({ server: SERVER, organization: OWNER, keyId: key?.keyId });
    expect(seen.map((s) => s.path)).toEqual(['/api/agents/enroll', '/api/agents/session']);
    expect(seen[0]?.body).toEqual({ ticket: TICKET, organization: OWNER, signingKey: key?.signingKey });
    expect(storedEnrollment()).toMatchObject({ server: SERVER, organization: OWNER });
    expect(readAgentKey(dir)?.enrollment?.server).toBe(SERVER);
  });

  test('enrolling again gives the agent a new key', async () => {
    expect((await enroll({ ticket: TICKET })).status).toBe(200);
    const first = readAgentKey(dir)?.keyId;
    expect((await enroll({ ticket: issueTicket() })).status).toBe(200);
    const second = readAgentKey(dir)?.keyId;
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
  });

  test('a member, a missing ticket or an agent with no organization cannot enroll', async () => {
    expect((await enroll({ ticket: TICKET }, 'member')).status).toBe(403);
    expect((await enroll({})).status).toBe(400);
    expect((await enroll({ ticket: 'short' })).status).toBe(400);
    deviceOwner = null;
    expect((await enroll({ ticket: TICKET })).status).toBe(409);
    expect(seen).toEqual([]);
  });

  test('a refusal from api.metro.box is passed on and nothing is saved', async () => {
    reply = (path) => path === '/api/agents/enroll' ? { status: 400, body: { error: 'This enrollment ticket is stale or belongs to another organization. Start again from the agent page.' } } : null;
    const res = await enroll({ ticket: TICKET });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('stale');
    expect(existsSync(join(dir, 'agent-key.json'))).toBe(false);
  });

  test('a failed enrollment keeps the existing legacy key and assignments identity', async () => {
    const old = newAgentKey();
    saveAgentKey(old, ENROLLED, dir);
    renameSync(join(dir, 'agent-key.json'), join(dir, 'box-key.json'));
    const bytes = readFileSync(join(dir, 'box-key.json'), 'utf8');
    reply = () => ({ status: 503, body: { error: 'Organization connectors are not switched on yet.' } });
    expect((await enroll({ ticket: TICKET })).status).toBe(503);
    expect(readFileSync(join(dir, 'box-key.json'), 'utf8')).toBe(bytes);
    expect(existsSync(join(dir, 'agent-key.json'))).toBe(false);
    expect(readAgentKey(dir)?.keyId).toBe(old.keyId);
  });

  test('an answer naming another organization or key does not replace the active key', async () => {
    reply = (path) => path === '/api/agents/enroll' ? { status: 200, body: { server: SERVER, organization: 'org_01SOMEONEELSE00', keyId: 'x' } } : null;
    expect((await enroll({ ticket: TICKET })).status).toBe(503);
    expect(existsSync(join(dir, 'agent-key.json'))).toBe(false);
    expect(readPendingAgentKey(OWNER, dir)).not.toBeNull();
  });

  test('a lost confirmation keeps the committed key and a retry recovers without rotating it', async () => {
    expect((await enroll({ ticket: TICKET })).status).toBe(200);
    const previous = readAgentKey(dir)?.keyId;
    const nextTicket = issueTicket();
    reply = (path) => path.endsWith('/session') ? { status: 503, body: { error: 'temporary failure' } } : null;
    expect((await enroll({ ticket: nextTicket })).status).toBe(503);
    const committed = readPendingAgentKey(OWNER, dir);
    expect(committed?.keyId).not.toBe(previous);
    expect(committed?.signingKey).toBe(enrolledKey);
    expect(readAgentKey(dir)?.keyId).toBe(previous);
    expect(statSync(join(dir, 'agent-key.pending.json')).mode & 0o777).toBe(0o600);
    expect(viewFiles(dir).has('agent-key.pending.json')).toBe(false);
    reply = null;
    seen = [];
    expect((await enroll({ ticket: nextTicket })).status).toBe(200);
    expect(seen.map((entry) => entry.path)).toEqual(['/api/agents/session']);
    expect(readAgentKey(dir)?.keyId).toBe(committed?.keyId);
    expect(readPendingAgentKey(OWNER, dir)).toBeNull();
  });

  test('a lost enrollment response leaves a durable key that the next request recovers', async () => {
    loseEnrollmentAnswer = true;
    expect((await enroll({ ticket: TICKET })).status).toBe(503);
    expect(readAgentKey(dir)).toBeNull();
    const pending = readPendingAgentKey(OWNER, dir);
    expect(pending?.signingKey).toBe(enrolledKey);
    loseEnrollmentAnswer = false;
    seen = [];
    expect((await enroll({ ticket: TICKET })).status).toBe(200);
    expect(seen.map((entry) => entry.path)).toEqual(['/api/agents/session']);
    expect(readAgentKey(dir)?.keyId).toBe(pending?.keyId);
  });

  test('overlapping enrollments cannot commit or save their keys out of order', async () => {
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    beforeReply = async (path) => {
      if (!path.endsWith('/session')) return;
      reached.resolve();
      await release.promise;
    };
    const first = enroll({ ticket: TICKET });
    await reached.promise;
    try {
      expect((await enroll({ ticket: TICKET })).status).toBe(409);
      expect(seen.filter((entry) => entry.path.endsWith('/enroll'))).toHaveLength(1);
    } finally {
      release.resolve();
    }
    expect((await first).status).toBe(200);
    expect(readAgentKey(dir)?.signingKey).toBe(enrolledKey);
    beforeReply = null;
    expect((await enroll({ ticket: issueTicket() })).status).toBe(200);
    expect(readAgentKey(dir)?.signingKey).toBe(enrolledKey);
  });

  test('a fresh ticket after interruption is exchanged for its own agent with a new key', async () => {
    loseEnrollmentAnswer = true;
    expect((await enroll({ ticket: TICKET })).status).toBe(503);
    const previous = readPendingAgentKey(OWNER, dir)?.keyId;
    loseEnrollmentAnswer = false;
    const next = issueTicket('agent000002');
    seen = [];
    const res = await enroll({ ticket: next });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ server: 'agent000002' });
    expect(seen.map((entry) => entry.path)).toEqual(['/api/agents/session', '/api/agents/enroll', '/api/agents/session']);
    expect(readAgentKey(dir)?.keyId).not.toBe(previous);
    expect(tickets.has(next)).toBe(false);
  });

  test('transient recovery failure does not replay a consumed ticket or overwrite pending state', async () => {
    loseEnrollmentAnswer = true;
    expect((await enroll({ ticket: TICKET })).status).toBe(503);
    const bytes = readFileSync(join(dir, 'agent-key.pending.json'), 'utf8');
    loseEnrollmentAnswer = false;
    reply = () => ({ status: 503, body: { error: 'temporary failure' } });
    seen = [];
    expect((await enroll({ ticket: TICKET })).status).toBe(503);
    expect(seen.map((entry) => entry.path)).toEqual(['/api/agents/session']);
    expect(readFileSync(join(dir, 'agent-key.pending.json'), 'utf8')).toBe(bytes);
    reply = () => ({ status: 200, body: { server: SERVER, organization: 'org_01SOMEONEELSE00', keyId: 'wrong' } });
    expect((await enroll({ ticket: issueTicket() })).status).toBe(503);
    expect(seen.filter((entry) => entry.path.endsWith('/enroll'))).toEqual([]);
  });

  test('a mismatched confirmation preserves the old active file and keeps the recovery key', async () => {
    expect((await enroll({ ticket: TICKET })).status).toBe(200);
    const old = readAgentKey(dir)?.keyId;
    reply = (path) => path.endsWith('/session') ? { status: 200, body: { server: 'agent000002', organization: OWNER, keyId: enrolledKey === null ? '' : agentKeyId(enrolledKey) } } : null;
    expect((await enroll({ ticket: issueTicket() })).status).toBe(503);
    expect(readAgentKey(dir)?.keyId).toBe(old);
    expect(readPendingAgentKey(OWNER, dir)?.signingKey).toBe(enrolledKey);
  });

  test('an unreadable pending key is not overwritten or sent to the API', async () => {
    writeFileSync(join(dir, 'agent-key.pending.json'), '{damaged-key');
    expect((await enroll({ ticket: TICKET })).status).toBe(503);
    expect(readFileSync(join(dir, 'agent-key.pending.json'), 'utf8')).toBe('{damaged-key');
    expect(seen).toEqual([]);
  });

  test('an organization change during enrollment does not save a key as the new owner', async () => {
    beforeReply = async () => { deviceOwner = 'org_01SOMEONEELSE00'; };
    expect((await enroll({ ticket: TICKET })).status).toBe(409);
    expect(readAgentKey(dir)).toBeNull();
    expect(readPendingAgentKey('org_01SOMEONEELSE00', dir)).toBeNull();
  });

  test('an answer too large for Metro is a 503 and saves nothing', async () => {
    reply = (path) => path === '/api/agents/enroll' ? { status: 200, body: { server: SERVER, organization: OWNER, padding: 'x'.repeat(100_000) } } : null;
    const res = await enroll({ ticket: TICKET });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain('too large');
    expect(existsSync(join(dir, 'agent-key.json'))).toBe(false);
  });

  test('api.metro.box down is a 503, never a 401', async () => {
    reply = () => ({ status: 500, body: { error: 'down' } });
    expect((await enroll({ ticket: TICKET })).status).toBe(503);
    reply = () => ({ status: 401, body: { error: 'This agent is not enrolled with Metro, or its request signature is not valid.' } });
    expect((await enroll({ ticket: TICKET })).status).toBe(400);
  });
});
