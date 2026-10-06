import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Account, accounts } from '../src/accounts.ts';
import { handleCall } from '../src/actions.ts';
import { checkScopes, refreshTokens } from '../src/auth.ts';
import { gmailJson } from '../src/api.ts';
import { revokeManaged } from '../src/managed.ts';
import { setManagedHost } from '../src/managed-binding.ts';
import { loadState, saveState, stateFiles } from '../src/state.ts';
import { capture, fakeFetch, json, useFakeGoogle } from './fake.ts';

const host = 'mailbox.example.test';
const org = 'org_example';
const seed = { id: 'managed-test', managed: true, managedHost: host, managedOrganization: org, accountEmail: 'reader@example.test', sendEnabled: false, accessToken: 'access-before', refreshToken: 'refresh-before', refreshGrant: 'grant-before', expiresAt: 0, authorizationId: 'first' };
let ownerPath = '';
const prior = { dir: process.env.METRO_AGENTS_DIR, url: process.env.METRO_PUBLIC_URL };

beforeEach(() => {
  useFakeGoogle();
  process.env.METRO_AGENTS_DIR = mkdtempSync(join(tmpdir(), 'gmail-owner-'));
  process.env.METRO_PUBLIC_URL = `https://${host}`;
  ownerPath = join(process.env.METRO_AGENTS_DIR, '.owner');
  writeFileSync(ownerPath, org);
  setManagedHost(`https://${host}`);
});

afterEach(() => {
  accounts.clear();
  if (prior.dir === undefined) delete process.env.METRO_AGENTS_DIR;
  else process.env.METRO_AGENTS_DIR = prior.dir;
  if (prior.url === undefined) delete process.env.METRO_PUBLIC_URL;
  else process.env.METRO_PUBLIC_URL = prior.url;
});

test('managed refresh is single flight and persists rotating token and grant together', async () => {
  const fake = fakeFetch([(req) => req.url.endsWith('/refresh') ? json({ accessToken: 'access-after', refreshToken: 'refresh-after', refreshGrant: 'grant-after', expiresAt: Date.now() + 3_600_000 }) : undefined]);
  const account = new Account(seed, fake.fetch);
  expect(await Promise.all([account.token(), account.token()])).toEqual(['access-after', 'access-after']);
  expect(fake.seen).toHaveLength(1);
  expect(JSON.parse(fake.seen[0]?.body ?? '{}')).toEqual({ refreshToken: 'refresh-before', refreshGrant: 'grant-before', host });
  expect(loadState(seed.id, seed)).toMatchObject({ refreshToken: 'refresh-after', refreshGrant: 'grant-after' });
  expect(statSync(stateFiles.path(seed.id)).mode & 0o777).toBe(0o600);
  expect(readFileSync(stateFiles.path(seed.id), 'utf8')).not.toContain('clientSecret');
});

test('owner or host changes block even a still-valid access token', async () => {
  const fake = fakeFetch([]);
  const account = new Account({ ...seed, expiresAt: Date.now() + 3_600_000 }, fake.fetch);
  writeFileSync(ownerPath, 'org_other');
  await expect(account.token()).rejects.toThrow('changed owner');
  writeFileSync(ownerPath, org);
  setManagedHost('https://other.example.test');
  await expect(account.token()).rejects.toThrow('changed owner or address');
  expect(fake.seen).toHaveLength(0);
});

test('a failed refresh preserves old credentials and does not echo upstream secrets', async () => {
  const fake = fakeFetch([() => json({ error: 'access-before refresh-before grant-before' }, 503)]);
  const account = new Account(seed, fake.fetch);
  await expect(account.token()).rejects.toThrow('Try again later');
  expect(account.state).toMatchObject({ refreshToken: seed.refreshToken, refreshGrant: seed.refreshGrant });
});

test('a new authorization replaces the old token pair but keeps history and delivered ids', () => {
  saveState(seed.id, { ...seed, historyId: 'cursor', seen: ['message'] });
  const renewed = loadState(seed.id, { ...seed, authorizationId: 'second', refreshToken: 'upgraded', refreshGrant: 'upgraded-grant' });
  expect(renewed).toMatchObject({ refreshToken: 'upgraded', refreshGrant: 'upgraded-grant', historyId: 'cursor', seen: ['message'] });
});

test('read-only blocks send and reply before fetching any file or Gmail endpoint', async () => {
  const fake = fakeFetch([]);
  accounts.set(seed.id, new Account(seed, fake.fetch));
  const cap = capture();
  try {
    for (const action of ['send', 'reply']) await handleCall({ op: 'call', id: action, action, args: { line: `metro://gmail/${seed.id}/recipient@example.test`, text: 'not sent', attachments: [{ url: 'https://example.test/file' }] } });
    expect(cap.written.responses).toHaveLength(2);
    for (const response of cap.written.responses) expect(String(response.error)).toContain('read-only');
    expect(fake.seen).toHaveLength(0);
  } finally {
    cap.restore();
  }
});

test('new BYO refresh proves exact scopes while legacy credentials remain compatible', async () => {
  const client = { clientId: 'test.apps.googleusercontent.com', clientSecret: 'test' };
  const withoutScope = fakeFetch([() => json({ access_token: 'new', expires_in: 3600 })]);
  expect(await refreshTokens(client, 'old', withoutScope.fetch)).toMatchObject({ accessToken: 'new', refreshToken: 'old' });
  await expect(refreshTokens(client, 'old', withoutScope.fetch, Date.now(), false)).rejects.toThrow('exactly');
  const read = 'https://www.googleapis.com/auth/gmail.readonly';
  const allowed = fakeFetch([() => json({ access_token: 'new', expires_in: 3600, scope: read })]);
  expect(await refreshTokens(client, 'old', allowed.fetch, Date.now(), false)).toMatchObject({ accessToken: 'new' });
  const broad = fakeFetch([() => json({ access_token: 'new', expires_in: 3600, scope: `${read} https://www.googleapis.com/auth/gmail.send` })]);
  await expect(refreshTokens(client, 'old', broad.fetch, Date.now(), false)).rejects.toThrow('exactly');
});

test('a BYO seed without a revision never reuses a managed token generation', () => {
  saveState(seed.id, { ...seed, historyId: null, seen: [] });
  expect(loadState(seed.id, { refreshToken: 'byo-refresh', accessToken: 'byo-access' })).toMatchObject({ accessToken: 'byo-access', refreshToken: 'byo-refresh', refreshGrant: undefined, authorizationId: undefined });
});

test('a running account follows host availability without a train restart', async () => {
  const account = new Account({ ...seed, expiresAt: Date.now() + 3_600_000 }, fakeFetch([]).fetch);
  setManagedHost(null);
  await expect(account.token()).rejects.toThrow('changed owner or address');
  setManagedHost(`https://${host}`);
  expect(await account.token()).toBe('access-before');
  setManagedHost('https://other.example.test');
  await expect(account.token()).rejects.toThrow('changed owner or address');
});

test('an owner move during the provider response or JSON body does not return mail', async () => {
  for (const when of ['response', 'body']) {
    writeFileSync(ownerPath, org);
    const fake = fakeFetch([() => {
      if (when === 'response') writeFileSync(ownerPath, 'org_other');
      const response = json({ privateMessage: 'not-returned' });
      if (when === 'body') response.json = () => { writeFileSync(ownerPath, 'org_other'); return Promise.resolve({ privateMessage: 'not-returned' }); };
      return response;
    }]);
    const account = new Account({ ...seed, expiresAt: Date.now() + 3_600_000 }, fake.fetch);
    await expect(gmailJson(account, '/gmail/v1/users/me/messages/example')).rejects.toThrow('changed owner');
    expect(fake.seen).toHaveLength(1);
  }
});

test('revocation requires explicit confirmation, not merely a successful HTTP status', async () => {
  for (const answer of [{}, { revoked: false }, { revoked: 'true' }]) {
    await expect(revokeManaged('refresh', 'grant', host, fakeFetch([() => json(answer)]).fetch)).rejects.toThrow('did not confirm');
  }
  await revokeManaged('refresh', 'grant', host, fakeFetch([() => json({ revoked: true })]).fetch);
});

test('disconnect drains rotating refresh, revokes the latest pair and blocks new mail calls', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const fake = fakeFetch([
    async (req) => {
      if (req.url.endsWith('/refresh')) {
        entered.resolve();
        await release.promise;
        return json({ accessToken: 'rotated-access', refreshToken: 'rotated-refresh', refreshGrant: 'rotated-grant', expiresAt: Date.now() + 3_600_000 });
      }
      return req.url.endsWith('/revoke') ? json({ revoked: true }) : undefined;
    },
  ]);
  const account = new Account(seed, fake.fetch);
  const pending = account.token().then(() => 'unexpected token', (err: unknown) => String(err));
  await entered.promise;
  const deletion = account.disconnect(seed.authorizationId);
  await expect(account.token()).rejects.toThrow('disconnecting');
  expect(fake.seen).toHaveLength(1);
  release.resolve();
  await deletion;
  expect(await pending).toContain('disconnecting');
  expect(JSON.parse(fake.seen[1]?.body ?? '{}')).toEqual({ refreshToken: 'rotated-refresh', refreshGrant: 'rotated-grant', host });
  await account.disconnect(seed.authorizationId);
  expect(fake.seen).toHaveLength(2);
  await expect(account.fetch('https://gmail.googleapis.com/example')).rejects.toThrow('disconnecting');
});

test('new consent requires exactly requested scopes, including sending only on upgrade', () => {
  const read = 'https://www.googleapis.com/auth/gmail.readonly';
  const send = 'https://www.googleapis.com/auth/gmail.send';
  expect(() => checkScopes(read, false)).not.toThrow();
  expect(() => checkScopes(`${read} ${send}`, true)).not.toThrow();
  for (const scope of [undefined, '', send, `${read} ${send}`, `${read} https://mail.google.com/`]) expect(() => checkScopes(scope, false)).toThrow('exactly');
  expect(() => checkScopes(read, true)).toThrow('exactly');
});
