import { generateKeyPairSync } from 'node:crypto';
import { setBearerSessions, type ApiSession } from '@metro-labs/http/api-http';
import { isOrganizationId, SigningKeys, verifyToken } from '@metro-labs/http/workos-token';
import { fakeIssuer, sessionClaims, type FakeIssuer } from '../../../packages/http/test/workos-fixture.ts';

export const TEST_OWNER = 'org_01TESTOWNER000000';

export type Who = string;

let issuer: Promise<{ started: FakeIssuer; keys: SigningKeys }> | null = null;

const ensureIssuer = (): Promise<{ started: FakeIssuer; keys: SigningKeys }> =>
  (issuer ??= fakeIssuer().then((started) => ({ started, keys: new SigningKeys(started.url) })));

export function installTestSessions(keys: SigningKeys): void {
  setBearerSessions(async (req): Promise<ApiSession | null> => {
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(/\s+/);
    if (scheme?.toLowerCase() !== 'bearer' || token === undefined) return null;
    const session = await verifyToken(token, keys);
    if (session === null || session.organization === null) return null;
    const subject = isOrganizationId(session.organization) ? session.organization : session.organization.toLowerCase();
    return { subject, role: session.role === 'member' ? 'member' : 'admin' };
  });
}

export async function bearer(claims: Record<string, unknown>): Promise<string> {
  const { started, keys } = await ensureIssuer();
  installTestSessions(keys);
  return `Bearer ${started.mint(sessionClaims(claims))}`;
}

const foreign = generateKeyPairSync('rsa', { modulusLength: 2048 });

export async function forged(who: Who = TEST_OWNER): Promise<string> {
  const { started, keys } = await ensureIssuer();
  installTestSessions(keys);
  return `Bearer ${started.mint(sessionClaims({ org_id: who, role: 'admin' }), { key: foreign.privateKey })}`;
}

export const auth = (who: Who, role: 'admin' | 'member' = 'admin'): Promise<string> => bearer({ org_id: who, role });
