import { createHash } from 'node:crypto';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { identityChallenge } from '../src/daemon/signed-identity.ts';
import { authorizeIdentity } from '../src/daemon/identity-registry.ts';

export const TEST_OWNER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
export const TEST_STRANGER = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');

export const KEY_VECTOR = {
  wallet: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
  signature:
    '0x436c286f6cddaa9f185c67520ecbd8b8cbc29db5384dd8a16bf9fb36d960ed656609521b2432028b53b2b68bfdcd918284348e0c69428dd6f18779fd06f03b7d1c' as `0x${string}`,
  identity: '0xfbd1aaf49dac784e5947725571bf20db7752f3d7',
} as const;

export type Who = string | PrivateKeyAccount;

const accounts = new Map<string, PrivateKeyAccount>();

export function identityFor(subject: string): PrivateKeyAccount {
  const key = `0x${createHash('sha256').update(`metro-test-identity:${subject}`).digest('hex')}` as `0x${string}`;
  const account = accounts.get(subject) ?? privateKeyToAccount(key);
  accounts.set(subject, account);
  authorizeIdentity(account.address, subject.toLowerCase());
  return account;
}

export async function auth(method: string, path: string, who: Who, at = Date.now()): Promise<string> {
  const account = typeof who === 'string' ? identityFor(who) : who;
  const bare = new URL(path, 'http://metro.invalid').pathname;
  const signature = await account.signMessage({ message: identityChallenge(method, bare, at) });
  return `Metro ${account.address.toLowerCase()} ${String(at)} ${signature}`;
}
