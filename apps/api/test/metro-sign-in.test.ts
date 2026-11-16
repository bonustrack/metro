import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { CONSUMER_TENANT, microsoftOwnDomain } from '../src/auth/providers.ts';
import { addMember } from '../src/db/memberships.ts';
import { authSessions, identities, users } from '../src/db/schema.ts';
import { ADMIN, claimsOf, claimsOfToken, harness, NOW, ORG, type Harness } from './metro-accounts-fixture.ts';
import { GOOGLE_CLIENT, MICROSOFT_CLIENT, WORK_TENANT } from './oauth-fake.ts';
import { PGLITE_START_MS, PGLITE_STEP_MS } from './pglite-db.ts';

let h: Harness;

beforeAll(async () => {
  h = await harness('metro');
}, PGLITE_START_MS);

beforeEach(async () => {
  await h.seed();
  h.clock.now = NOW;
}, PGLITE_STEP_MS);

afterAll(async () => {
  await h.close();
});

const addByEmail = (email: string, role: 'admin' | 'member' = 'member'): ReturnType<typeof addMember> => addMember(h.held.db, { organization: ORG, email, role, by: ADMIN, now: (h.clock.now += 1) });

const identitiesOf = async (user: string): Promise<string[]> => (await h.held.db.select().from(identities).where(eq(identities.userId, user))).map((i) => `${i.provider}:${i.subject}`).sort();

const userCount = async (): Promise<number> => (await h.held.db.select().from(users)).length;

describe('signing in with Google, called by Metro itself', () => {
  test('the login sends the browser to Google with PKCE S256, a nonce, the one callback path and select_account', async () => {
    const res = await h.start('google');
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get('location') ?? '');
    expect(to.origin).toBe('https://google.example');
    expect(Object.fromEntries(to.searchParams)).toMatchObject({ client_id: GOOGLE_CLIENT, redirect_uri: `${h.base}/api/auth/callback`, response_type: 'code', scope: 'openid email profile', prompt: 'select_account', code_challenge_method: 'S256' });
    expect(to.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(to.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await h.start('github')).status).toBe(400);
    expect((await h.json('POST', '/api/auth/email/start', { email: 'ana@example.com' })).status).toBe(404);
    expect((await h.json('POST', '/api/auth/email/verify', { email: 'ana@example.com', code: '123456' })).status).toBe(404);
  });

  test('a person added by email is claimed by their first Google sign-in with that address and lands in the organization', async () => {
    const added = await addByEmail('ana@example.com');
    const tokens = await h.tokens('google', claimsOf('google'));
    expect(tokens.user).toMatchObject({ id: added.user, email: 'ana@example.com', name: 'Ana Lima', picture: 'https://lh3.example/ana.png' });
    expect(tokens).toMatchObject({ organization: ORG, organizationName: 'Stage Labs', organizationSlug: 'stage-labs' });
    expect(tokens.refreshToken).toMatch(/^mrt_[A-Za-z0-9_-]{43}$/);
    const access = claimsOfToken(tokens.accessToken);
    expect(access).toMatchObject({ iss: 'https://api.metro.box', sub: added.user, org_id: ORG, role: 'member' });
    expect(Number(access.exp) - Number(access.iat)).toBe(600);
    expect(String(access.sid)).toMatch(/^session_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(await identitiesOf(added.user)).toEqual(['google:104857600000000000001']);
    const session = (await h.held.db.select().from(authSessions))[0];
    expect(session).toMatchObject({ id: access.sid, userId: added.user, method: 'google', refreshHash: createHash('sha256').update(tokens.refreshToken).digest('base64url') });
    const me = (await (await h.json('GET', '/api/auth/me', undefined, tokens.accessToken)).json()) as Record<string, unknown>;
    expect(me).toMatchObject({ userId: added.user, organization: ORG, role: 'member' });
    expect(h.fake.exchanges.at(-1)?.form.get('redirect_uri')).toBe(`${h.base}/api/auth/callback`);
  });

  test('a stranger is turned away, can join the waitlist, and a rejected one is told Metro is not open to them', async () => {
    expect(await h.land('google', claimsOf('google', { email: 'new@example.com', sub: 'stranger-1' }))).toBe('#/login?refused=no-account');
    expect(await h.land('google', claimsOf('google', { email: 'new@example.com', sub: 'stranger-1' }), { intent: 'waitlist' })).toBe('#/waitlist?joined=1');
    const stranger = (await h.held.db.select().from(users).where(eq(users.email, 'new@example.com')))[0];
    expect(stranger?.status).toBe('waitlist');
    await h.deps.users.setStatus(stranger?.id ?? '', 'rejected');
    expect(await h.land('google', claimsOf('google', { email: 'new@example.com', sub: 'stranger-1' }))).toBe('#/login?refused=not-open');
    expect(await h.held.db.select().from(authSessions)).toEqual([]);
  });

  test('Google must say the email is verified, even for a known account', async () => {
    await addByEmail('ana@example.com');
    expect(await h.land('google', claimsOf('google', { email_verified: false }))).toBe('#/login?refused=unverified');
    expect(await h.land('google', claimsOf('google', { email_verified: 'true' }))).toMatch(/^#\/auth\//);
    expect(await h.land('google', claimsOf('google', { email_verified: false }))).toBe('#/login?refused=unverified');
  });

  test('a wrong issuer, nonce, audience, signature or an expired token fails the sign-in and writes nothing', async () => {
    await addByEmail('ana@example.com');
    const before = await userCount();
    expect(await h.land('google', claimsOf('google', { iss: 'https://accounts.evil.example' }))).toBe('#/login?refused=failed');
    expect(await h.land('google', (_nonce, now) => claimsOf('google')('another-nonce', now))).toBe('#/login?refused=failed');
    expect(await h.land('google', claimsOf('google', { aud: 'someone-else' }))).toBe('#/login?refused=failed');
    expect(await h.land('google', claimsOf('google'), { key: 'other' })).toBe('#/login?refused=failed');
    expect(await h.land('google', claimsOf('google', { exp: Math.floor(NOW / 1000) - 120 }))).toBe('#/login?refused=failed');
    expect(await userCount()).toBe(before);
    expect(await h.held.db.select().from(identities)).toEqual([]);
  });

  test('a cancelled sign-in and a stale state are told apart from a failure', async () => {
    const to = new URL((await h.start('google')).headers.get('location') ?? '');
    const back = await fetch(`${h.base}/api/auth/callback?error=access_denied&state=${to.searchParams.get('state') ?? ''}`, { redirect: 'manual' });
    expect(new URL(back.headers.get('location') ?? '').hash).toBe('#/login?refused=cancelled');
    expect((await fetch(`${h.base}/api/auth/callback?state=nope`, { redirect: 'manual' })).status).toBe(400);
  });

  test('the phone sign-in returns to metro://auth and its handoff needs the verifier', async () => {
    await addByEmail('ana@example.com');
    const verifier = 'v'.repeat(43);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    expect((await h.start('google', { returnTo: 'metro://auth' })).status).toBe(400);
    const hash = await h.land('google', claimsOf('google'), { returnTo: 'metro://auth', appChallenge: challenge });
    const handoff = /^#\/auth\/(.+)$/.exec(hash)?.[1] ?? '';
    expect((await h.json('POST', '/api/auth/exchange', { code: handoff })).status).toBe(404);
    const again = /^#\/auth\/(.+)$/.exec(await h.land('google', claimsOf('google'), { returnTo: 'metro://auth', appChallenge: challenge }))?.[1] ?? '';
    expect((await h.json('POST', '/api/auth/exchange', { code: again, verifier })).status).toBe(200);
  });
});

describe('signing in with Microsoft, on the common authority', () => {
  test('a work account whose tenant proves the email (xms_edov) is linked by tenant and object id', async () => {
    const added = await addByEmail('ana@anderra.ch');
    const to = new URL((await h.start('microsoft')).headers.get('location') ?? '');
    expect(to.origin).toBe('https://microsoft.example');
    expect(Object.fromEntries(to.searchParams)).toMatchObject({ client_id: MICROSOFT_CLIENT, scope: 'openid email profile', response_mode: 'query', prompt: 'select_account', code_challenge_method: 'S256' });
    const tokens = await h.tokens('microsoft', claimsOf('microsoft'));
    expect(tokens.user.id).toBe(added.user);
    expect(await identitiesOf(added.user)).toEqual([`microsoft:${WORK_TENANT}:3b5a7c1e-2d4f-4a6b-8c9d-0e1f2a3b4c5d`]);
    expect((await h.held.db.select().from(authSessions))[0]?.method).toBe('microsoft');
  });

  test('the issuer must name the token\'s own tenant', async () => {
    await addByEmail('ana@anderra.ch');
    expect(await h.land('microsoft', claimsOf('microsoft', { iss: `https://login.microsoftonline.com/${CONSUMER_TENANT}/v2.0` }))).toBe('#/login?refused=failed');
    expect(await h.land('microsoft', claimsOf('microsoft', { iss: 'https://login.microsoftonline.com/common/v2.0' }))).toBe('#/login?refused=failed');
    expect(await h.land('microsoft', claimsOf('microsoft', { oid: 'not-a-guid' }))).toBe('#/login?refused=failed');
  });

  test('nOAuth: an email claim without xms_edov proves nothing, and preferred_username or upn are never read', async () => {
    const victim = await addByEmail('ana@anderra.ch', 'admin');
    const attacker = { tid: '11111111-2222-3333-4444-555555555555', oid: '99999999-8888-7777-6666-555555555555', email: 'ana@anderra.ch', preferred_username: 'ana@anderra.ch', upn: 'ana@anderra.ch' };
    expect(await h.land('microsoft', claimsOf('microsoft', { ...attacker, xms_edov: undefined }))).toBe('#/login?refused=unverified');
    expect(await h.land('microsoft', claimsOf('microsoft', { ...attacker, xms_edov: false }))).toBe('#/login?refused=unverified');
    expect(await h.land('microsoft', claimsOf('microsoft', { ...attacker, email: undefined, xms_edov: true }))).toBe('#/login?refused=unverified');
    expect(await identitiesOf(victim.user)).toEqual([]);
    expect(await h.held.db.select().from(authSessions)).toEqual([]);
  });

  test('a personal account proves only an address on Microsoft\'s own domains', async () => {
    await addByEmail('ana@outlook.com');
    await addByEmail('ana@gmail.com');
    const personal = { tid: CONSUMER_TENANT, oid: '00000000-0000-0000-66f3-3332eca7ea81', xms_edov: undefined };
    expect(await h.land('microsoft', claimsOf('microsoft', { ...personal, email: 'ana@outlook.com' }))).toMatch(/^#\/auth\//);
    expect(await h.land('microsoft', claimsOf('microsoft', { ...personal, oid: '00000000-0000-0000-1111-222233334444', email: 'ana@gmail.com' }))).toBe('#/login?refused=unverified');
    expect(['outlook.com', 'hotmail.fr', 'live.co.uk', 'outlook.com.br', 'msn.com'].map((d) => microsoftOwnDomain(`a@${d}`))).toEqual([true, true, true, true, true]);
    expect(['gmail.com', 'outlook.evil.com', 'msn.fr', 'hotmail.com.evil.io'].map((d) => microsoftOwnDomain(`a@${d}`))).toEqual([false, false, false, false]);
  });

  test('a known Microsoft account signs in by its id alone, even when its email is not proven any more', async () => {
    const added = await addByEmail('ana@anderra.ch');
    await h.tokens('microsoft', claimsOf('microsoft'));
    const again = await h.tokens('microsoft', claimsOf('microsoft', { xms_edov: undefined, email: 'renamed@anderra.ch' }));
    expect(again.user).toMatchObject({ id: added.user, email: 'ana@anderra.ch' });
  });
});

describe('linking sign-ins to people', () => {
  test('a new sign-in is linked to an existing person by a proven email, so one person has both', async () => {
    const added = await addByEmail('ana@example.com');
    await h.tokens('google', claimsOf('google'));
    const viaMicrosoft = await h.tokens('microsoft', claimsOf('microsoft', { email: 'ana@example.com' }));
    expect(viaMicrosoft.user.id).toBe(added.user);
    expect(await identitiesOf(added.user)).toEqual(['google:104857600000000000001', `microsoft:${WORK_TENANT}:3b5a7c1e-2d4f-4a6b-8c9d-0e1f2a3b4c5d`]);
  });

  test('two people are never merged: an identity stays with its person, and a second Google account for a taken email is refused', async () => {
    const ana = await addByEmail('ana@example.com');
    const bob = await addByEmail('bob@anderra.ch');
    await h.tokens('google', claimsOf('google'));
    await h.tokens('microsoft', claimsOf('microsoft', { email: 'bob@anderra.ch' }));
    const people = await userCount();
    const asBob = await h.tokens('microsoft', claimsOf('microsoft', { email: 'ana@example.com' }));
    expect(asBob.user.id).toBe(bob.user);
    expect(await h.land('google', claimsOf('google', { sub: '200000000000000000002' }))).toBe('#/login?refused=other-account');
    expect(await userCount()).toBe(people);
    expect(await identitiesOf(ana.user)).toEqual(['google:104857600000000000001']);
    expect(await identitiesOf(bob.user)).toEqual([`microsoft:${WORK_TENANT}:3b5a7c1e-2d4f-4a6b-8c9d-0e1f2a3b4c5d`]);
  });

  test('a name the person chose is kept over the provider\'s on later sign-ins', async () => {
    await addByEmail('ana@example.com');
    const first = await h.tokens('google', claimsOf('google'));
    expect((await h.json('PUT', '/api/auth/account', { name: 'Ana L.' }, first.accessToken)).status).toBe(200);
    const again = await h.tokens('google', claimsOf('google', { name: 'Ana From Google' }));
    expect(again.user.name).toBe('Ana L.');
  });
});
