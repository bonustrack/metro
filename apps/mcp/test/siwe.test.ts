import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage, type SiweMessage } from 'viem/siwe';
import { handleSiweAuthRequest } from '../src/daemon/siwe-routes.js';
import { allowedSiweDomain, verifySiweLogin } from '../src/daemon/siwe-auth.js';
import { mintNonce, nonceCount, takeNonce } from '../src/daemon/siwe-nonces.js';
import { verifySession } from '../src/daemon/session.js';
import { ApiError } from '../src/daemon/api-error.js';

const SECRET = 'siwe-test-secret';
const ACCOUNT = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const OTHER = privateKeyToAccount(
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
);
const TEN_MINUTES = 600_000;

function message(over: Partial<SiweMessage> = {}, now = new Date()): string {
  return createSiweMessage({
    address: ACCOUNT.address,
    chainId: 1,
    domain: 'metro.box',
    nonce: mintNonce(),
    uri: 'https://metro.box',
    version: '1',
    issuedAt: now,
    expirationTime: new Date(now.getTime() + TEN_MINUTES),
    ...over,
  });
}

async function signed(
  over: Partial<SiweMessage> = {},
  now = new Date(),
  signer = ACCOUNT,
): Promise<{ message: string; signature: string }> {
  const text = message(over, now);
  return { message: text, signature: await signer.signMessage({ message: text }) };
}

describe('verifying a sign-in message', () => {
  test('a message signed by its own address yields the lowercase address, once', async () => {
    const login = await signed();
    expect(await verifySiweLogin(login, { takeNonce })).toBe(
      ACCOUNT.address.toLowerCase(),
    );
    await expect(verifySiweLogin(login, { takeNonce })).rejects.toThrow(
      'already used',
    );
  });

  test('a message for another site is refused before its nonce is spent', async () => {
    const nonce = mintNonce();
    const login = await signed({ domain: 'evil.example', uri: 'https://evil.example', nonce });
    await expect(verifySiweLogin(login, { takeNonce })).rejects.toThrow(
      'not accepted here',
    );
    expect(takeNonce(nonce)).toBe(true);
  });

  test('a uri on a different site than the domain is refused', async () => {
    const login = await signed({ uri: 'https://evil.example/' });
    await expect(verifySiweLogin(login, { takeNonce })).rejects.toThrow(
      'different site',
    );
  });

  test('an expired message is refused', async () => {
    const login = await signed({}, new Date(Date.now() - 2 * TEN_MINUTES));
    await expect(verifySiweLogin(login, { takeNonce })).rejects.toThrow(
      'expired or does not match',
    );
  });

  test('a signature by another key is a 401, not a 400', async () => {
    const login = await signed({}, new Date(), OTHER);
    const failure = await verifySiweLogin(login, { takeNonce }).catch(
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(401);
  });

  test('a nonce nobody minted, and a signature that is not one, are refused', async () => {
    const stranger = await signed({ nonce: 'notminted1234567' });
    await expect(verifySiweLogin(stranger, { takeNonce })).rejects.toThrow(
      'already used',
    );
    await expect(
      verifySiweLogin({ message: message(), signature: '0x12' }, { takeNonce }),
    ).rejects.toThrow('not an Ethereum signature');
  });

  test('the accepted domains are the web ui hosts, port included for local dev', () => {
    expect(allowedSiweDomain('metro.box')).toBe(true);
    expect(allowedSiweDomain('localhost:5173')).toBe(true);
    expect(allowedSiweDomain('127.0.0.1:5173')).toBe(true);
    expect(allowedSiweDomain('feature--metro-ui.netlify.app')).toBe(true);
    expect(allowedSiweDomain('evil.example')).toBe(false);
    expect(allowedSiweDomain('metro.box.evil.example')).toBe(false);
  });
});

describe('the sign-in routes', () => {
  let server: Server;
  let base = '';
  const ensured: string[] = [];
  const prev = process.env.METRO_SESSION_SECRET;

  beforeAll(async () => {
    process.env.METRO_SESSION_SECRET = SECRET;
    server = createServer((req, res) => {
      if (
        handleSiweAuthRequest(req, res, {
          ensureUser: (address) => {
            ensured.push(address);
            return Promise.resolve('user0000001');
          },
        })
      )
        return;
      res.writeHead(418).end();
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

  const verify = (body: unknown): Promise<Response> =>
    fetch(`${base}/auth/siwe/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  test('a nonce is minted per request and a signed message trades for a session', async () => {
    const before = nonceCount();
    const { nonce } = (await (await fetch(`${base}/auth/siwe/nonce`)).json()) as {
      nonce: string;
    };
    expect(nonce).toMatch(/^[a-z0-9]{16,}$/i);
    expect(nonceCount()).toBe(before + 1);
    const login = await signed({ nonce });
    const res = await verify(login);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: string; address: string };
    expect(body.address).toBe(ACCOUNT.address.toLowerCase());
    expect(verifySession(body.session, SECRET)).toEqual({
      subject: ACCOUNT.address.toLowerCase(),
      agentIds: [],
    });
    expect(ensured).toEqual([ACCOUNT.address.toLowerCase()]);
    expect((await verify(login)).status).toBe(400);
  });

  test('a body without a message or signature is 400, and nothing is looked up', async () => {
    const count = ensured.length;
    expect((await verify({ message: 'x' })).status).toBe(400);
    expect((await verify(42)).status).toBe(400);
    expect(ensured.length).toBe(count);
  });

  test('the wrong method is 405, preflight is 204, other paths fall through', async () => {
    expect((await fetch(`${base}/auth/siwe/nonce`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${base}/auth/siwe/verify`)).status).toBe(405);
    expect((await fetch(`${base}/auth/siwe/nonce`, { method: 'OPTIONS' })).status).toBe(204);
    expect((await fetch(`${base}/auth/google/start`)).status).toBe(418);
  });

  test('without a session secret sign-in is 503', async () => {
    process.env.METRO_SESSION_SECRET = '';
    expect((await fetch(`${base}/auth/siwe/nonce`)).status).toBe(503);
    process.env.METRO_SESSION_SECRET = SECRET;
  });
});
