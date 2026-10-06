import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { AttachSessions, type AttachOwner } from '../src/stations/attach-session.ts';
import { assertAttachOwner, startGmailAttach, finishGmailUpgrade } from '../src/routes/gmail-attach.ts';
import { detachWithGmailRevocation } from '../src/routes/gmail-detach.ts';
import { localCreateAgent, localAttachAccount, localOwner, setLocalOwner, readLocalAgentFile, localImportAgent, localRenewGmail } from '../src/agents/file-admin.ts';
import { setTrainCallBackend } from '../src/stations/train-call.ts';
import { Account, type AccountConfig } from '../../../packages/gmail/src/accounts.ts';

const org = 'org_01MANAGEDTEST00000000000000';
const host = 'box.example.test';
const base = 'https://api.metro.box/api/gmail/';
const realFetch = globalThis.fetch;
let owner: AttachOwner;
let session: AttachSessions;
let requests: { path: string; body: Record<string, unknown>; bearer: string }[];
let holdExchange: (() => Promise<void>) | undefined;
let holdRevoke: (() => Promise<void>) | undefined;
let rejectRevoke = false;
let serial = 0;
const flows = new Map<string, Record<string, unknown>>();
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status });

async function broker(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const path = String(input).slice(base.length);
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  requests.push({ path, body, bearer: new Headers(init?.headers).get('authorization') ?? '' });
  if (path === 'start') {
    const state = `state-${String(++serial)}`;
    flows.set(state, body);
    const query = new URLSearchParams({ state, redirect_uri: 'https://metro.box/', code_challenge: String(body.challenge) });
    return json({ state, authorizeUrl: `https://accounts.google.com/o/oauth2/v2/auth?${query.toString()}`, expiresAt: Date.now() + 600_000 });
  }
  if (path === 'exchange') {
    const flow = flows.get(String(body.state));
    expect(createHash('sha256').update(String(body.verifier)).digest('base64url')).toBe(String(flow?.challenge));
    await holdExchange?.();
    return json({ accessToken: 'secret-access', refreshToken: 'secret-refresh', refreshGrant: 'secret-grant', expiresAt: Date.now() + 3_600_000, managed: true, managedHost: host, accountEmail: flow?.mailbox ?? 'reader@example.test', sendEnabled: flow?.sendEnabled });
  }
  if (path === 'revoke') {
    await holdRevoke?.();
    return json({ revoked: !rejectRevoke }, rejectRevoke ? 503 : 200);
  }
  if (path === 'cancel') return json({ cancelled: true });
  throw new Error('unexpected fake broker route');
}

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), 'managed-gmail-'));
  process.env.METRO_AGENTS_DIR = join(root, 'agents');
  process.env.GMAIL_STATE_DIR = root;
  process.env.METRO_TRAINS_DIR = join(root, 'trains');
  process.env.METRO_PUBLIC_URL = `https://${host}`;
  setLocalOwner(org);
  const agent = await localCreateAgent();
  owner = { agentId: agent.id, organization: org, userId: 'user-example', sessionId: 'session-example', authorization: 'Bearer start' };
  requests = [];
  holdExchange = undefined;
  holdRevoke = undefined;
  rejectRevoke = false;
  flows.clear();
  globalThis.fetch = broker as typeof fetch;
  setTrainCallBackend(async (station, action, input) => {
    expect(station).toBe('gmail');
    expect(action).toBe('disconnect');
    const args = input as { account: string; authorizationId: unknown };
    const saved = readLocalAgentFile(owner.agentId).stations.find((a) => a.id === args.account);
    const account = new Account({ ...saved?.config, id: args.account } as AccountConfig);
    await account.disconnect(args.authorizationId);
    return { op: 'response', id: 'synthetic', result: { revoked: true } };
  });
  session = new AttachSessions({ authorize: (who) => { assertAttachOwner(who); return Promise.resolve(); }, start: startGmailAttach, complete: async (who, station, config, active) => {
    assertAttachOwner(who);
    if (!active()) throw new Error('cancelled');
    const ref = finishGmailUpgrade(who, config) ?? await localAttachAccount(who.agentId, station, config);
    return { accountId: ref.accountId, activated: true };
  } });
});

afterEach(async () => {
  await session.stop();
  globalThis.fetch = realFetch;
});

async function connect(mailbox = 'reader@example.test'): Promise<string> {
  const view = await session.start(owner, 'gmail', { mode: 'managed', mailbox, sendEnabled: 'true' });
  const state = new URL(view.authorizeUrl ?? '').searchParams.get('state');
  await session.submit({ ...owner, authorization: 'Bearer current' }, view.attachId, { code: 'code', state });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const done = session.view(owner, view.attachId);
  expect(done.status).toBe('done');
  expect(JSON.stringify(done)).not.toContain('secret-');
  return done.accountId ?? '';
}

test('new managed connections force read-only, bind current bearer, support separate mailboxes', async () => {
  await connect();
  await connect('second@example.test');
  const saved = readLocalAgentFile(owner.agentId).stations;
  expect(saved).toHaveLength(2);
  expect(saved[0]?.config).toMatchObject({ managed: true, managedOrganization: org, managedHost: host, sendEnabled: false });
  expect(saved[0]?.policy).toEqual({ write: 'deny' });
  expect(requests.filter((r) => r.path === 'exchange').every((r) => r.bearer === 'Bearer current')).toBe(true);
  expect(requests.filter((r) => r.path === 'start').every((r) => r.body.sendEnabled === false)).toBe(true);
});

test('another user, session, organization or agent cannot poll, complete or cancel the attempt', async () => {
  const view = await session.start(owner, 'gmail', { mode: 'managed' });
  for (const changed of [{ userId: 'other' }, { sessionId: 'other' }, { organization: 'org_other' }, { agentId: 'other' }]) {
    const wrong = { ...owner, ...changed };
    expect(() => session.view(wrong, view.attachId)).toThrow('no such');
    await expect(session.submit(wrong, view.attachId, { state: 'wrong', code: 'code' })).rejects.toThrow('no such');
    await expect(session.cancel(wrong, view.attachId)).rejects.toThrow('no such');
  }
  expect(requests).toHaveLength(1);
});

test('cancelling an exchange in flight cannot attach its eventual tokens', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  holdExchange = () => { entered.resolve(); return release.promise; };
  const view = await session.start(owner, 'gmail', { mode: 'managed' });
  const step = session.submit(owner, view.attachId, { code: 'code', state: new URL(view.authorizeUrl ?? '').searchParams.get('state') });
  await entered.promise;
  await session.cancel(owner, view.attachId);
  release.resolve();
  await step;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(readLocalAgentFile(owner.agentId).stations).toEqual([]);
});

test('local ownership is rechecked after the exchange, before writing tokens', async () => {
  holdExchange = () => { setLocalOwner('org_01OTHERTEST000000000000000'); return Promise.resolve(); };
  const view = await session.start(owner, 'gmail', { mode: 'managed' });
  await session.submit(owner, view.attachId, { code: 'code', state: new URL(view.authorizeUrl ?? '').searchParams.get('state') });
  expect(localOwner()).not.toBe(org);
  expect(readLocalAgentFile(owner.agentId).stations).toEqual([]);
});

test('sending upgrade uses the stored mailbox and preserves id, settings and Metro policy', async () => {
  const id = await connect();
  const before = readLocalAgentFile(owner.agentId).stations[0];
  const view = await session.start(owner, 'gmail', { mode: 'upgrade', accountId: id, mailbox: 'attacker@example.test', clientSecret: 'not-used' });
  expect(requests.at(-1)?.body).toMatchObject({ mailbox: 'reader@example.test', sendEnabled: true });
  await session.submit(owner, view.attachId, { code: 'code', state: new URL(view.authorizeUrl ?? '').searchParams.get('state') });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const after = readLocalAgentFile(owner.agentId).stations[0];
  expect(after).toMatchObject({ id, policy: before?.policy, allowlist: before?.allowlist, enabled: before?.enabled, config: { sendEnabled: true } });
  expect(after?.config.authorizationId).not.toBe(before?.config.authorizationId);
});

test('expiry is enforced before a sweep and no exchange is attempted', async () => {
  const view = await session.start(owner, 'gmail', { mode: 'managed' });
  const clock = spyOn(Date, 'now').mockReturnValue(view.expiresAt);
  try {
    expect(() => session.view(owner, view.attachId)).toThrow('expired');
    await expect(session.submit(owner, view.attachId, { code: 'code', state: new URL(view.authorizeUrl ?? '').searchParams.get('state') })).rejects.toThrow('expired');
    expect(requests.filter((r) => r.path === 'exchange')).toHaveLength(0);
  } finally {
    clock.mockRestore();
  }
});

test('parallel callback replay exchanges the code only once', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  holdExchange = () => { entered.resolve(); return release.promise; };
  const view = await session.start(owner, 'gmail', { mode: 'managed' });
  const callback = { code: 'code', state: new URL(view.authorizeUrl ?? '').searchParams.get('state') };
  const first = session.submit(owner, view.attachId, callback);
  await entered.promise;
  await expect(session.submit(owner, view.attachId, callback)).rejects.toThrow('finished');
  release.resolve();
  await first;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(requests.filter((r) => r.path === 'exchange')).toHaveLength(1);
  expect(readLocalAgentFile(owner.agentId).stations).toHaveLength(1);
});

test('declined and cancelled upgrades preserve every saved account field', async () => {
  const id = await connect();
  const before = readLocalAgentFile(owner.agentId).stations;
  const declined = await session.start(owner, 'gmail', { mode: 'upgrade', accountId: id });
  await session.submit(owner, declined.attachId, { error: 'access_denied', errorDescription: 'secret-provider-detail', state: new URL(declined.authorizeUrl ?? '').searchParams.get('state') });
  expect(session.view(owner, declined.attachId).status).toBe('failed');
  expect(JSON.stringify(session.view(owner, declined.attachId))).not.toContain('secret-provider-detail');
  expect(readLocalAgentFile(owner.agentId).stations).toEqual(before);
  const cancelled = await session.start(owner, 'gmail', { mode: 'upgrade', accountId: id });
  await session.cancel(owner, cancelled.attachId);
  await expect(session.submit(owner, cancelled.attachId, { code: 'late', state: new URL(cancelled.authorizeUrl ?? '').searchParams.get('state') })).rejects.toThrow('no such');
  expect(readLocalAgentFile(owner.agentId).stations).toEqual(before);
});

test('an owner move before submission refuses before asking the broker to exchange', async () => {
  const view = await session.start(owner, 'gmail', { mode: 'managed' });
  setLocalOwner('org_01OTHERTEST000000000000000');
  await expect(session.submit(owner, view.attachId, { code: 'code', state: new URL(view.authorizeUrl ?? '').searchParams.get('state') })).rejects.toThrow();
  expect(requests.filter((r) => r.path === 'exchange')).toHaveLength(0);
  expect(readLocalAgentFile(owner.agentId).stations).toHaveLength(0);
});

test('deletion blocks an in-flight upgrade from committing during revocation', async () => {
  const id = await connect();
  const view = await session.start(owner, 'gmail', { mode: 'upgrade', accountId: id });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  holdRevoke = () => { entered.resolve(); return release.promise; };
  const deletion = detachWithGmailRevocation(owner.agentId, 'gmail', id);
  await entered.promise;
  await session.submit(owner, view.attachId, { code: 'code', state: new URL(view.authorizeUrl ?? '').searchParams.get('state') });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(session.view(owner, view.attachId)).toMatchObject({ status: 'failed' });
  expect(readLocalAgentFile(owner.agentId).stations[0]?.config.sendEnabled).toBe(false);
  release.resolve();
  await deletion;
  expect(readLocalAgentFile(owner.agentId).stations).toHaveLength(0);
});

test('deletion never removes a changed generation or owner after awaiting revocation', async () => {
  for (const changed of ['generation', 'owner']) {
    setLocalOwner(org);
    const id = await connect(`${changed}@example.test`);
    const saved = readLocalAgentFile(owner.agentId).stations.find((a) => a.id === id);
    holdRevoke = () => {
      if (changed === 'owner') setLocalOwner('org_01OTHERTEST000000000000000');
      else localRenewGmail(owner.agentId, id, String(saved?.config.authorizationId), { ...saved?.config, authorizationId: 'newer-generation' });
      return Promise.resolve();
    };
    await expect(detachWithGmailRevocation(owner.agentId, 'gmail', id)).rejects.toThrow('changed during deletion');
    expect(readLocalAgentFile(owner.agentId).stations.some((a) => a.id === id)).toBe(true);
  }
});

test('an unavailable or unconfirmed train keeps the channel', async () => {
  const id = await connect();
  setTrainCallBackend(() => Promise.resolve({ op: 'response', id: 'test', result: { revoked: false } }));
  await expect(detachWithGmailRevocation(owner.agentId, 'gmail', id)).rejects.toThrow('channel was kept');
  setTrainCallBackend(() => Promise.reject(new Error('train unavailable')));
  await expect(detachWithGmailRevocation(owner.agentId, 'gmail', id)).rejects.toThrow('channel was kept');
  expect(readLocalAgentFile(owner.agentId).stations).toHaveLength(1);
});

test('managed credentials cannot be imported and disconnect requires Google revocation', async () => {
  const id = await connect();
  const agent = readLocalAgentFile(owner.agentId);
  await expect(localImportAgent({ id: agent.id, name: 'example', key: null, accounts: agent.stations })).rejects.toThrow('cannot be imported');
  const masked = agent.stations.map((a) => ({ ...a, config: { accountEmail: 'other@example.test', managed: false, clientId: 'byo', clientSecret: 'byo', refreshToken: 'byo' } }));
  await expect(localImportAgent({ id: agent.id, name: 'example', key: null, accounts: masked })).rejects.toThrow('cannot be overwritten');
  rejectRevoke = true;
  await expect(detachWithGmailRevocation(owner.agentId, 'gmail', id)).rejects.toThrow('channel was kept');
  expect(readLocalAgentFile(owner.agentId).stations).toHaveLength(1);
  rejectRevoke = false;
  await detachWithGmailRevocation(owner.agentId, 'gmail', id);
  expect(readLocalAgentFile(owner.agentId).stations).toHaveLength(0);
  expect(requests.at(-1)?.body).toMatchObject({ refreshToken: 'secret-refresh', refreshGrant: 'secret-grant', host });
});
