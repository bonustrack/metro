import { createHash } from 'node:crypto';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { identityChallenge } from '@metro-labs/http/signed-identity';
import { authorizeIdentity } from '@metro-labs/http/identity-registry';

export const TEST_OWNER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
export const TEST_STRANGER = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');

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
