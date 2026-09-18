import { SigningKeys } from '@metro-labs/http/workos-token';
import { fakeIssuer, sessionClaims, type FakeIssuer } from '../../../packages/http/test/workos-fixture.ts';

export const TEST_OWNER = 'org_01TESTOWNER000000';
export const TEST_STRANGER = 'org_01TESTSTRANGER00';

export type Who = string;

let issuer: Promise<FakeIssuer> | null = null;

const ensureIssuer = (): Promise<FakeIssuer> => (issuer ??= fakeIssuer());

export async function testKeys(): Promise<SigningKeys> {
  return new SigningKeys((await ensureIssuer()).url);
}

export async function bearer(claims: Record<string, unknown>): Promise<string> {
  return `Bearer ${(await ensureIssuer()).mint(sessionClaims(claims))}`;
}

export async function auth(_method: string, _path: string, who: Who, role: 'admin' | 'member' = 'admin'): Promise<string> {
  const started = await ensureIssuer();
  return `Bearer ${started.mint(sessionClaims({ org_id: who, role }))}`;
}
