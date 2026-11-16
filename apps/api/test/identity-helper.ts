import { JwksKeys } from '@metro-labs/http/user-token';
import { fakeIssuer, sessionClaims, type FakeIssuer } from '../../../packages/http/test/token-fixture.ts';

export const TEST_OWNER = 'org_01TESTOWNER000000';
export const TEST_STRANGER = 'org_01TESTSTRANGER00';

export type Who = string;

let issuer: Promise<FakeIssuer> | null = null;

const ensureIssuer = (): Promise<FakeIssuer> => (issuer ??= fakeIssuer());

export async function testKeys(): Promise<JwksKeys> {
  return new JwksKeys((await ensureIssuer()).url);
}

export async function bearer(claims: Record<string, unknown>): Promise<string> {
  return `Bearer ${(await ensureIssuer()).mint(sessionClaims(claims))}`;
}

export async function auth(who: Who, role: 'admin' | 'member' = 'admin'): Promise<string> {
  const started = await ensureIssuer();
  return `Bearer ${started.mint(sessionClaims({ org_id: who, role }))}`;
}
