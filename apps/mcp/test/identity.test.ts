import { afterEach, describe, expect, test } from 'bun:test';
import type { IncomingMessage } from 'node:http';
import { privateKeyToAccount } from 'viem/accounts';
import { identityChallenge, parseIdentityHeader, signedIdentity } from '../src/daemon/signed-identity.ts';
import { deriveIdentityAddress, deriveIdentityKey } from '../src/daemon/identity-key.ts';
import { authorizeIdentity, identitySubject, resetIdentities } from '../src/daemon/identity-registry.ts';
import { KEY_VECTOR, TEST_OWNER } from './identity-helper.ts';

afterEach(() => resetIdentities());

const req = (method: string, url: string, authorization?: string): IncomingMessage =>
  ({ method, url, headers: authorization === undefined ? {} : { authorization } }) as unknown as IncomingMessage;

describe('the identity the browser derives from one wallet signature', () => {
  test('the daemon derives the same address the page does, from the same signature', () => {
    expect(deriveIdentityAddress(KEY_VECTOR.signature)).toBe(KEY_VECTOR.identity);
    expect(privateKeyToAccount(deriveIdentityKey(KEY_VECTOR.signature)).address.toLowerCase()).toBe(KEY_VECTOR.identity);
  });

  test('a signed request recovers its identity; a stale, altered or foreign one recovers nothing', async () => {
    const at = 1_700_000_000_000;
    const path = '/api/agents';
    const signature = await TEST_OWNER.signMessage({ message: identityChallenge('GET', path, at) });
    const header = `Metro ${TEST_OWNER.address} ${String(at)} ${signature}`;
    expect(parseIdentityHeader(header)).toEqual({ address: TEST_OWNER.address.toLowerCase(), at, signature });
    expect(await signedIdentity(req('GET', `${path}?project=x`, header), at + 1000)).toBe(TEST_OWNER.address.toLowerCase());
    expect(await signedIdentity(req('GET', path, header), at + 6 * 60_000)).toBeNull();
    expect(await signedIdentity(req('POST', path, header), at)).toBeNull();
    expect(await signedIdentity(req('GET', '/api/other', header), at)).toBeNull();
    expect(await signedIdentity(req('GET', path, header.replace('Metro', 'Vault')), at)).toBeNull();
    expect(await signedIdentity(req('GET', path, `Bearer ${signature}`), at)).toBeNull();
    expect(await signedIdentity(req('GET', path), at)).toBeNull();
  });

  test('the registry maps an identity to the subject it acts for, case-insensitively', () => {
    authorizeIdentity(TEST_OWNER.address, '0xABCDEF0000000000000000000000000000000001');
    expect(identitySubject(TEST_OWNER.address.toLowerCase())).toBe('0xabcdef0000000000000000000000000000000001');
    expect(identitySubject('0x0000000000000000000000000000000000000000')).toBeUndefined();
  });
});
