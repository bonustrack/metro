import { afterEach, describe, expect, test } from 'bun:test';
import nacl from 'tweetnacl';
import {
  publicKeyOf,
  ThreemaGatewayError,
  verifyThreemaGateway,
} from '../src/verify.ts';

const secretKey = new Uint8Array(32).fill(7);
const PRIVATE = Buffer.from(secretKey).toString('hex');
const PUBLIC = Buffer.from(nacl.box.keyPair.fromSecretKey(secretKey).publicKey).toString('hex');

const realFetch = globalThis.fetch;
let urls: string[] = [];

function stubFetch(answer: (url: string) => [number, string] | never): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const [status, body] = answer(url);
    return Promise.resolve(new Response(body, { status }));
  }) as typeof globalThis.fetch;
}

const gateway = (credits: string, pubkey: string) => (url: string): [number, string] =>
  url.includes('/credits') ? [200, credits] : [200, pubkey];

afterEach(() => {
  globalThis.fetch = realFetch;
  urls = [];
});

describe('the X25519 public key node derives', () => {
  test('is the one nacl derives from the same private key', () => {
    expect(publicKeyOf(PRIVATE)).toBe(PUBLIC);
  });
});

describe('verifyThreemaGateway', () => {
  test('checks the credentials against /credits and the key against /pubkeys', async () => {
    stubFetch(gateway('17\n', `${PUBLIC.toUpperCase()}\n`));
    const identity = await verifyThreemaGateway({
      gatewayId: ' *metro01 ',
      secret: 's3cret',
      privateKey: `private:${PRIVATE.toUpperCase()}`,
    });
    expect(identity).toEqual({ gatewayId: '*METRO01', publicKey: PUBLIC, credits: 17 });
    expect(urls).toEqual([
      'https://msgapi.threema.ch/credits?from=*METRO01&secret=s3cret',
      'https://msgapi.threema.ch/pubkeys/*METRO01?from=*METRO01&secret=s3cret',
    ]);
  });

  test('a refused secret names the credentials and never the secret', async () => {
    stubFetch(() => [401, '']);
    const err = await verifyThreemaGateway({ gatewayId: '*METRO01', secret: 'nope', privateKey: PRIVATE }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ThreemaGatewayError);
    expect((err as Error).message).toBe('Threema rejected that Gateway ID or API secret');
    expect((err as Error).message).not.toContain('nope');
  });

  test('a private key the Gateway holds another public half for is refused', async () => {
    stubFetch(gateway('1', 'ab'.repeat(32)));
    const err = await verifyThreemaGateway({ gatewayId: '*METRO01', secret: 's', privateKey: PRIVATE }).catch((e: unknown) => e);
    expect((err as Error).message).toContain('does not belong to *METRO01');
    expect(urls).toHaveLength(2);
  });

  test('a malformed id or key is refused before anything is asked of Threema', async () => {
    stubFetch(gateway('1', PUBLIC));
    for (const [gatewayId, privateKey, reason] of [
      ['ECHOECHO', PRIVATE, 'Gateway ID is a *'],
      ['*TOOLONGID', PRIVATE, 'Gateway ID is a *'],
      ['*METRO01', 'private:abc', '64 hex characters'],
      ['*METRO01', '', '64 hex characters'],
    ]) {
      const err = await verifyThreemaGateway({ gatewayId, secret: 's', privateKey }).catch((e: unknown) => e);
      expect((err as Error).message).toContain(reason);
    }
    expect(urls).toHaveLength(0);
  });

  test('an unexpected answer and an unreachable Gateway are clear errors', async () => {
    stubFetch(gateway('lots', PUBLIC));
    await expect(verifyThreemaGateway({ gatewayId: '*METRO01', secret: 's', privateKey: PRIVATE })).rejects.toThrow('unexpected answer');
    globalThis.fetch = (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof globalThis.fetch;
    await expect(verifyThreemaGateway({ gatewayId: '*METRO01', secret: 's', privateKey: PRIVATE })).rejects.toThrow('could not reach the Threema Gateway');
  });
});
