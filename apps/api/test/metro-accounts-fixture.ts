import { createHash, generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleModeRequest } from '@metro-labs/http/mode-api';
import { handleAdminApiRequest, type AdminApiDeps } from '../src/admin.ts';
import { metroDirectory } from '../src/auth/directory.ts';
import { handleMembersApiRequest } from '../src/auth/members.ts';
import { signInChoices, type ProviderId } from '../src/auth/providers.ts';
import { handleAuthApiRequest, type AuthApiDeps } from '../src/auth/routes.ts';
import { mintAccessToken, readSigningKeys, type AccessClaims } from '../src/auth/signing-keys.ts';
import { accountId } from '../src/db/account-ids.ts';
import { organizationStore } from '../src/db/organizations.ts';
import { memberships, organizations, users } from '../src/db/schema.ts';
import { userStore } from '../src/db/users.ts';
import { fakeAccount, fakeDeletionAws } from './deletion-fake.ts';
import { fakeProviders, googleClaims, microsoftClaims, type FakeProviders } from './oauth-fake.ts';
import { testDb, type TestDb } from './pglite-db.ts';

export const NOW = Date.now();
export const ORG = 'org_01KSTAGELABS0000000000000';
export const OTHER_ORG = 'org_01KELSEWHERE0000000000000';
export const ADMIN = accountId('user', NOW);
export const WEB_VERIFIER = 'w'.repeat(43);
export const WEB_CHALLENGE = createHash('sha256').update(WEB_VERIFIER).digest('base64url');

export interface TokenBody {
  accessToken: string;
  refreshToken: string;
  organization: string | null;
  organizationName: string | null;
  organizationSlug: string | null;
  user: { id: string; email: string | null; name: string | null; picture: string | null };
}

type ClaimsOf = (nonce: string, now: number) => Record<string, unknown>;

interface Start {
  state: string;
  nonce: string;
  challenge: string;
  location: URL;
}

export interface LandOptions {
  key?: 'right' | 'other';
  intent?: 'login' | 'waitlist';
  returnTo?: string;
  challenge?: string | null;
  address?: string;
}

export interface Harness {
  base: string;
  held: TestDb;
  deps: AuthApiDeps & AdminApiDeps;
  fake: FakeProviders;
  clock: { now: number };
  bearer: (claims: Omit<AccessClaims, 'sid'>) => string;
  json: (method: string, path: string, body?: unknown, bearer?: string, headers?: Record<string, string>) => Promise<Response>;
  start: (provider: string, options?: LandOptions) => Promise<Response>;
  land: (provider: ProviderId, claims: ClaimsOf, options?: LandOptions) => Promise<string>;
  tokens: (provider: ProviderId, claims: ClaimsOf) => Promise<TokenBody>;
  seed: () => Promise<void>;
  close: () => Promise<void>;
}

export const claimsOf = (provider: ProviderId, extra: Record<string, unknown> = {}): ClaimsOf => (nonce, now) => (provider === 'google' ? googleClaims(nonce, now, extra) : microsoftClaims(nonce, now, extra));

export const claimsOfToken = (token: string): Record<string, unknown> => JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;

function startOf(response: Response): Start {
  const location = new URL(response.headers.get('location') ?? '');
  return { location, state: location.searchParams.get('state') ?? '', nonce: location.searchParams.get('nonce') ?? '', challenge: location.searchParams.get('code_challenge') ?? '' };
}

export async function harness(): Promise<Harness> {
  const held = await testDb();
  let base = '';
  const fake = await fakeProviders(() => `${base}/api/auth/callback`);
  const clock = { now: NOW };
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const signing = readSigningKeys({ METRO_AUTH_SIGNING_KEY: privateKey });
  const db = (): TestDb['db'] => held.db;
  const store = organizationStore(db);
  const now = (): number => clock.now;
  const deps: AuthApiDeps & AdminApiDeps = {
    directory: metroDirectory(db, now),
    db,
    signing,
    providers: fake.providers,
    keys: signing,
    slugs: store,
    orgAvatars: store,
    users: userStore(db),
    publicBase: () => base,
    now,
    agents: () => Promise.resolve([]),
    deletion: { config: () => ({ ok: false, missing: [] }), lookup: () => Promise.reject(new Error('not used here')), remove: () => Promise.resolve(null), resizing: () => false, aws: fakeDeletionAws(fakeAccount()) },
  };
  const server: Server = createServer((req, res) => {
    if (handleModeRequest(req, res, () => ({ mode: 'hosted', owner: null, version: 'test', ...signInChoices(fake.providers) }))) return;
    if (handleAuthApiRequest(req, res, deps) || handleMembersApiRequest(req, res, deps) || handleAdminApiRequest(req, res, deps)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const json: Harness['json'] = (method, path, body, bearer, headers = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const start: Harness['start'] = (provider, options = {}) => {
    const challenge = options.challenge === undefined ? WEB_CHALLENGE : options.challenge;
    const query = new URLSearchParams({ provider, return_to: options.returnTo ?? 'https://metro.box/', ...(options.intent === undefined ? {} : { intent: options.intent }), ...(challenge === null ? {} : { code_challenge: challenge }) });
    return fetch(`${base}/api/auth/login?${query.toString()}`, { redirect: 'manual', headers: { 'fly-client-ip': options.address ?? '192.0.2.1' } });
  };
  const land: Harness['land'] = async (provider, claims, options = {}) => {
    const started = startOf(await start(provider, options));
    const code = fake.issue({ provider, claims: claims(started.nonce, clock.now), challenge: started.challenge, key: options.key ?? 'right' });
    const back = await fetch(`${base}/api/auth/callback?code=${code}&state=${encodeURIComponent(started.state)}`, { redirect: 'manual' });
    return new URL(back.headers.get('location') ?? '').hash;
  };
  const tokens: Harness['tokens'] = async (provider, claims) => {
    const hash = await land(provider, claims);
    const handoff = /^#\/auth\/(.+)$/.exec(hash)?.[1];
    if (handoff === undefined) throw new Error(`no handoff in ${hash}`);
    const exchanged = await json('POST', '/api/auth/exchange', { code: handoff, verifier: WEB_VERIFIER });
    if (exchanged.status !== 200) throw new Error(`exchange answered ${String(exchanged.status)}`);
    return (await exchanged.json()) as TokenBody;
  };
  const seed = async (): Promise<void> => {
    await held.reset();
    await held.db.insert(organizations).values([
      { id: ORG, slug: 'stage-labs', name: 'Stage Labs', createdAt: 'x', updatedAt: 'x' },
      { id: OTHER_ORG, slug: 'elsewhere', name: 'Elsewhere', createdAt: 'x', updatedAt: 'x' },
    ]);
    await held.db.insert(users).values({ id: ADMIN, email: 'admin@example.com', name: 'Ada Admin', updatedAt: 'x' });
    await held.db.insert(memberships).values({ id: accountId('om', NOW), organization: ORG, userId: ADMIN, role: 'admin', createdAt: NOW - 1000, updatedAt: NOW - 1000 });
  };
  return {
    get base() {
      return base;
    },
    held,
    deps,
    fake,
    clock,
    bearer: (claims) => mintAccessToken(signing, { sid: 'session_01XYZ', ...claims }),
    json,
    start,
    land,
    tokens,
    seed,
    close: async () => {
      server.close();
      await Promise.all([fake.close(), held.close()]);
    },
  };
}
