import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleCliPairRequest } from '../src/daemon/cli-pair-api.js';
import { signSession, verifySession } from '../src/daemon/session.js';

const SECRET = 'a-test-session-secret';
const EMAIL = 'less@bonustrack.co';

let server: Server;
let base = '';
const prev = process.env.METRO_SESSION_SECRET;

beforeAll(async () => {
  process.env.METRO_SESSION_SECRET = SECRET;
  server = createServer((req, res) => {
    if (handleCliPairRequest(req, res)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(() => {
  server.close();
  if (prev === undefined) delete process.env.METRO_SESSION_SECRET;
  else process.env.METRO_SESSION_SECRET = prev;
});

const session = (): string => signSession({ email: EMAIL, agentIds: [] }, SECRET);

const mint = (token?: string): Promise<Response> =>
  fetch(`${base}/api/cli/code`, {
    method: 'POST',
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });

const claim = (code: unknown): Promise<Response> =>
  fetch(`${base}/api/cli/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });

async function freshCode(): Promise<string> {
  const body = (await (await mint(session())).json()) as { code: string };
  return body.code;
}

describe('minting a pairing code', () => {
  test('it needs a signed-in session, exactly like every other user route', async () => {
    expect((await mint()).status).toBe(401);
    expect((await mint('not-a-session')).status).toBe(401);
  });

  test('a signed-in owner gets a code back', async () => {
    const res = await mint(session());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string; expiresAt: number };
    expect(body.code).toMatch(/^mc_[A-Za-z0-9_-]{16}$/);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });
});

describe('claiming a pairing code', () => {
  test('it takes no session — that is the whole point — and returns one', async () => {
    const res = await claim(await freshCode());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: string; email: string };
    expect(body.email).toBe(EMAIL);
    expect(verifySession(body.session, SECRET).email).toBe(EMAIL);
  });

  test('the session it mints is not accepted by a different secret', async () => {
    const body = (await (await claim(await freshCode())).json()) as {
      session: string;
    };
    expect(() => verifySession(body.session, 'another-secret')).toThrow();
  });

  test('a code works once and never again', async () => {
    const code = await freshCode();
    expect((await claim(code)).status).toBe(200);
    expect((await claim(code)).status).toBe(400);
  });

  test('a code nobody minted is refused', async () => {
    expect((await claim('mc_aaaaaaaaaaaaaaaa')).status).toBe(400);
  });

  test('a malformed code is refused without reaching the store', async () => {
    for (const bad of ['', 'nope', 'mc_short', 42, null])
      expect((await claim(bad)).status).toBe(400);
  });
});

describe('the shape of the route itself', () => {
  test('GET is refused, so a code cannot be minted by a link', async () => {
    expect((await fetch(`${base}/api/cli/code`)).status).toBe(405);
  });

  test('anything else under /api/cli is a flat 404', async () => {
    expect((await fetch(`${base}/api/cli/nope`, { method: 'POST' })).status).toBe(404);
  });
});
