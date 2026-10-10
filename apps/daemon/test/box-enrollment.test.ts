import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomInt } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { log } from '@metro-labs/core/log';
import { readBodyBytes, setBearerSessions } from '@metro-labs/http/api-http';
import { boxKeyId, boxSignatureValid, readBoxProof } from '@metro-labs/http/box-signature';
import { SigningKeys } from '@metro-labs/http/workos-token';
import { fakeIssuer, sessionClaims, type FakeIssuer } from '../../../packages/http/test/workos-fixture.ts';
import { bearerSessionsFor } from '../src/routes/bearer.ts';
import { handleSessionApis } from '../src/routes/session-apis.ts';
import { newBoxKey, readBoxKey, saveBoxKey } from '../src/connectors/box-key.ts';
import { viewFiles } from '../src/agent-user/view.ts';

const OWNER = 'org_01BOXOWNER00000';
const SERVER = 'agent000001';
const TICKET = 'T'.repeat(43);

interface Seen {
  path: string;
  body: Record<string, unknown>;
}

let issuer: FakeIssuer;
let root = '';
let dir = '';
let boxBase = '';
let apiBase = '';
let deviceOwner: string | null = OWNER;
let seen: Seen[] = [];
let enrolledKey: string | null = null;
let reply: ((path: string) => { status: number; body: unknown } | null) | null = null;
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
  const proof = readBoxProof(req.headers.authorization);
  const signingKey = path === '/api/boxes/enroll' ? String(body.signingKey) : enrolledKey;
  const request = { method: req.method ?? '', host: req.headers.host ?? '', path, body: bytes };
  if (proof === null || signingKey === null || !boxSignatureValid(request, proof, signingKey)) {
    send(res, 401, { error: 'This box is not enrolled with Metro, or its request signature is not valid.' });
    return;
  }
  const custom = reply?.(path) ?? null;
  if (custom !== null) {
    send(res, custom.status, custom.body);
    return;
  }
  if (path === '/api/boxes/enroll') enrolledKey = signingKey;
  send(res, 200, { server: SERVER, organization: OWNER, keyId: boxKeyId(signingKey), enrolledAt: '2026-10-09T00:00:00.000Z' });
}

const enroll = (body: unknown, role = 'admin'): Promise<Response> => fetch(`${boxBase}/api/enrollment`, {
  method: 'POST',
  headers: { authorization: `Bearer ${issuer.mint(sessionClaims({ org_id: OWNER, role }))}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const storedEnrollment = (): unknown => (JSON.parse(readFileSync(join(dir, 'box-key.json'), 'utf8')) as { enrollment?: unknown }).enrollment;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'metro-enrollment-'));
  issuer = await fakeIssuer();
  const keys = new SigningKeys(issuer.url);
  apiBase = await listen((req, res) => {
    fakeApi(req, res).catch(() => {
      send(res, 500, { error: 'fake api failed' });
    });
  });
  boxBase = await listen((req, res) => {
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
  reply = null;
});

afterAll(async () => {
  setBearerSessions(null);
  for (const server of servers) await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  await issuer.close();
  rmSync(root, { recursive: true, force: true });
});

const ENROLLED = { server: SERVER, organization: OWNER, at: '2026-10-09T00:00:00.000Z' };

describe('the box key', () => {
  test('is made in memory, saved 0600 in Metro folder with its enrollment, and read back the same', () => {
    expect(readBoxKey(dir)).toBeNull();
    const made = newBoxKey();
    expect(made.keyId).toBe(boxKeyId(made.signingKey));
    expect(existsSync(join(dir, 'box-key.json'))).toBe(false);
    saveBoxKey(made, ENROLLED, dir);
    expect(statSync(join(dir, 'box-key.json')).mode & 0o777).toBe(0o600);
    const back = readBoxKey(dir);
    expect(back?.keyId).toBe(made.keyId);
    expect(back?.sealingKey).toBe(made.sealingKey);
    expect(back?.enrollment).toEqual(ENROLLED);
    expect(newBoxKey().keyId).not.toBe(made.keyId);
  });

  test('a damaged file reads as no key, and its content never reaches the log', () => {
    const warnings = spyOn(log, 'warn');
    writeFileSync(join(dir, 'box-key.json'), '{"version":1,"signing":MC4CAQAwBQYDK2VwBCIEIDamaged');
    expect(readBoxKey(dir)).toBeNull();
    writeFileSync(join(dir, 'box-key.json'), JSON.stringify({ version: 1, signing: 'bm90IGEga2V5', sealing: 'bm90IGEga2V5' }));
    expect(readBoxKey(dir)).toBeNull();
    expect(warnings).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warnings.mock.calls)).not.toContain('MC4CAQ');
    warnings.mockRestore();
  });

  test('never reaches the agent view', () => {
    saveBoxKey(newBoxKey(), ENROLLED, dir);
    const files = viewFiles(dir);
    expect(files.has('box-key.json')).toBe(false);
    expect([...files.values()].join('\n')).not.toContain(readFileSync(join(dir, 'box-key.json'), 'utf8').slice(0, 60));
  });
});

describe('POST /api/enrollment', () => {
  test('an admin enrolls the box: signed enroll, signed session, then the enrollment is saved', async () => {
    const res = await enroll({ ticket: TICKET });
    expect(res.status).toBe(200);
    const key = readBoxKey(dir);
    expect(await res.json()).toEqual({ server: SERVER, organization: OWNER, keyId: key?.keyId });
    expect(seen.map((s) => s.path)).toEqual(['/api/boxes/enroll', '/api/boxes/session']);
    expect(seen[0]?.body).toEqual({ ticket: TICKET, organization: OWNER, signingKey: key?.signingKey, sealingKey: key?.sealingKey });
    expect(storedEnrollment()).toMatchObject({ server: SERVER, organization: OWNER });
    expect(readBoxKey(dir)?.enrollment?.server).toBe(SERVER);
  });

  test('enrolling again gives the box a new key', async () => {
    expect((await enroll({ ticket: TICKET })).status).toBe(200);
    const first = readBoxKey(dir)?.keyId;
    expect((await enroll({ ticket: TICKET })).status).toBe(200);
    const second = readBoxKey(dir)?.keyId;
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
  });

  test('a member, a missing ticket or a box with no organization cannot enroll', async () => {
    expect((await enroll({ ticket: TICKET }, 'member')).status).toBe(403);
    expect((await enroll({})).status).toBe(400);
    expect((await enroll({ ticket: 'short' })).status).toBe(400);
    deviceOwner = null;
    expect((await enroll({ ticket: TICKET })).status).toBe(409);
    expect(seen).toEqual([]);
  });

  test('a refusal from api.metro.box is passed on and nothing is saved', async () => {
    reply = (path) => path === '/api/boxes/enroll' ? { status: 400, body: { error: 'This enrollment ticket is stale or belongs to another organization. Start again from the agent page.' } } : null;
    const res = await enroll({ ticket: TICKET });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('stale');
    expect(existsSync(join(dir, 'box-key.json'))).toBe(false);
  });

  test('an answer naming another organization, agent or key saves nothing', async () => {
    reply = (path) => path === '/api/boxes/enroll' ? { status: 200, body: { server: SERVER, organization: 'org_01SOMEONEELSE00', keyId: 'x' } } : null;
    expect((await enroll({ ticket: TICKET })).status).toBe(503);
    reply = (path) => path === '/api/boxes/session' ? { status: 200, body: { server: 'agent000002', organization: OWNER, keyId: enrolledKey === null ? '' : boxKeyId(enrolledKey) } } : null;
    expect((await enroll({ ticket: TICKET })).status).toBe(503);
    expect(existsSync(join(dir, 'box-key.json'))).toBe(false);
  });

  test('an answer too large for Metro is a 503 and saves nothing', async () => {
    reply = (path) => path === '/api/boxes/enroll' ? { status: 200, body: { server: SERVER, organization: OWNER, padding: 'x'.repeat(100_000) } } : null;
    const res = await enroll({ ticket: TICKET });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain('too large');
    expect(existsSync(join(dir, 'box-key.json'))).toBe(false);
  });

  test('api.metro.box down is a 503, never a 401', async () => {
    reply = () => ({ status: 500, body: { error: 'down' } });
    expect((await enroll({ ticket: TICKET })).status).toBe(503);
    reply = () => ({ status: 401, body: { error: 'This box is not enrolled with Metro, or its request signature is not valid.' } });
    expect((await enroll({ ticket: TICKET })).status).toBe(400);
  });
});
