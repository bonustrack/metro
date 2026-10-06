import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { readGmailGrant } from '../src/gmail/grants.js';
import { CONFIG, HOST, READ_SCOPE, SEND_SCOPE, SESSION, credential, gmailFixture } from './gmail-fake.js';

const signed = (grant: string, changes: Record<string, unknown>): string => {
  const payload = JSON.parse(Buffer.from(grant.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;
  const next = Buffer.from(JSON.stringify({ ...payload, ...changes })).toString('base64url');
  return `gmail1.${next}.${createHmac('sha256', CONFIG.grantKey).update(`gmail1.${next}`).digest('base64url')}`;
};

describe('managed Gmail refresh capability', () => {
  test('refreshes headlessly, checks current access, and renews a maximum ninety-day grant', async () => {
    const f = gmailFixture();
    const connected = await f.connected();
    f.state.requests = [];
    f.state.allowedChecks = [];
    f.state.now += 86_400_000;
    const renewed = await f.broker.refresh(credential(connected));
    expect(renewed).toMatchObject({
      accessToken: 'fake-renewed-access', refreshToken: connected.refreshToken, accountEmail: connected.accountEmail,
      managed: true, managedHost: HOST, sendEnabled: false, expiresAt: f.state.now + 3_600_000,
    });
    expect(renewed.refreshGrant).not.toBe(connected.refreshGrant);
    const grant = readGmailGrant(renewed.refreshGrant, renewed.refreshToken, HOST, CONFIG, f.state.now);
    expect(grant.issuedAt).toBe(f.state.now);
    expect(grant.expiresAt).toBe(f.state.now + 90 * 86_400_000);
    expect(f.state.allowedChecks).toEqual([[SESSION.userId, SESSION.organization], [SESSION.userId, SESSION.organization]]);
    expect(f.state.requests).toHaveLength(1);
    const request = f.state.requests[0]!;
    expect(request.url).toBe('https://oauth2.googleapis.com/token');
    expect(Object.fromEntries(new URLSearchParams(String(request.init?.body)))).toEqual({
      client_id: CONFIG.clientId, client_secret: CONFIG.clientSecret,
      grant_type: 'refresh_token', refresh_token: 'fake-refresh',
    });
  });

  test('a rotated refresh token gets a new digest and cannot use the old grant', async () => {
    const f = gmailFixture();
    const old = await f.connected();
    f.state.refresh.refresh_token = 'rotated-refresh';
    const renewed = await f.broker.refresh(credential(old));
    expect(renewed.refreshToken).toBe('rotated-refresh');
    expect(renewed.refreshGrant).not.toBe(old.refreshGrant);
    await expect(f.broker.refresh({ ...credential(old), refreshToken: renewed.refreshToken })).rejects.toThrow('grant');
    await expect(f.broker.refresh({ ...credential(renewed), refreshToken: old.refreshToken })).rejects.toThrow('grant');
    await expect(f.broker.refresh(credential(renewed))).resolves.toMatchObject({ refreshToken: 'rotated-refresh' });
  });

  test('tampering, wrong host, token, client, key and expiry fail before any Google or authorization lookup', async () => {
    for (const problem of ['signature', 'payload', 'host', 'token', 'client', 'key', 'expired', 'format']) {
      const f = gmailFixture();
      const connected = await f.connected();
      f.state.requests = [];
      f.state.allowedChecks = [];
      const input = credential(connected);
      if (problem === 'signature') input.refreshGrant = input.refreshGrant.slice(0, -4) + 'AAAA';
      if (problem === 'payload') input.refreshGrant = input.refreshGrant.replace('gmail1.', 'gmail1.A');
      if (problem === 'format') input.refreshGrant += '.extra';
      if (problem === 'host') input.host = 'other.tail1234.ts.net';
      if (problem === 'token') input.refreshToken = 'stolen-other-refresh';
      if (problem === 'client') f.state.config = { ...CONFIG, clientId: 'different-client' };
      if (problem === 'key') f.state.config = { ...CONFIG, grantKey: Buffer.alloc(32, 9) };
      if (problem === 'expired') f.state.now += 90 * 86_400_000;
      await expect(f.broker.refresh(input)).rejects.toThrow('grant');
      expect(f.state.requests).toHaveLength(0);
      expect(f.state.allowedChecks).toHaveLength(0);
    }
  });

  test('even a signed malformed, future or overlong grant is refused', async () => {
    const f = gmailFixture();
    const connected = await f.connected();
    const badClaims = [
      { issuedAt: f.state.now + 1 }, { issuedAt: -1 }, { issuedAt: 'now' },
      { expiresAt: f.state.now + 91 * 86_400_000 }, { expiresAt: f.state.now },
      { expiresAt: Number.MAX_SAFE_INTEGER + 1 }, { sendEnabled: 'true' },
      { organization: 'other' }, { userId: '' }, { serverId: '../saved' }, { agentId: '../agent' },
      { email: null }, { refreshDigest: 'wrong' },
    ];
    f.state.requests = [];
    for (const claims of badClaims) {
      await expect(f.broker.refresh({ ...credential(connected), refreshGrant: signed(connected.refreshGrant, claims) })).rejects.toThrow('grant');
    }
    expect(f.state.requests).toHaveLength(0);
  });

  test('server removal, move, replacement, address changes and user removal stop durable refresh', async () => {
    for (const problem of ['removed', 'moved', 'replaced', 'host', 'user']) {
      const f = gmailFixture();
      const connected = await f.connected();
      if (problem === 'removed') f.state.rows = [];
      if (problem === 'moved') f.state.rows[0]!.organization = 'org_01OTHERORG0000';
      if (problem === 'replaced') f.state.rows[0]!.id = 'saved000002';
      if (problem === 'host') f.state.rows[0]!.host = 'other.tail1234.ts.net';
      if (problem === 'user') f.state.allowed = false;
      f.state.requests = [];
      await expect(f.broker.refresh(credential(connected))).rejects.toThrow();
      expect(f.state.requests).toHaveLength(0);
    }
  });

  test('membership and exact server ownership are checked again after Google refreshes', async () => {
    for (const change of ['removed', 'moved', 'replaced', 'host', 'user']) {
      const f = gmailFixture();
      const connected = await f.connected();
      f.state.requests = [];
      f.state.allowedChecks = [];
      f.state.onRequest = () => {
        if (change === 'removed') f.state.rows = [];
        if (change === 'moved') f.state.rows[0]!.organization = 'org_01OTHERORG0000';
        if (change === 'replaced') f.state.rows[0]!.id = 'saved000002';
        if (change === 'host') f.state.rows[0]!.host = 'other.tail1234.ts.net';
        if (change === 'user') f.state.allowed = false;
      };
      await expect(f.broker.refresh(credential(connected))).rejects.toThrow();
      expect(f.state.requests).toHaveLength(1);
      expect(f.state.allowedChecks).toEqual([[SESSION.userId, SESSION.organization], [SESSION.userId, SESSION.organization]]);
    }
  });

  test('refresh never upgrades or downgrades consent from the stored scope policy', async () => {
    const f = gmailFixture();
    const readonly = await f.connected();
    for (const scope of [undefined, '', SEND_SCOPE, `${READ_SCOPE} ${SEND_SCOPE}`, `${READ_SCOPE} openid`, null]) {
      f.state.refresh.scope = scope;
      await expect(f.broker.refresh(credential(readonly))).rejects.toThrow('permissions');
    }
    f.state.refresh.scope = READ_SCOPE;
    await expect(f.broker.refresh(credential(readonly))).resolves.toMatchObject({ sendEnabled: false });
    const sending = await f.connected(true);
    await expect(f.broker.refresh(credential(sending))).rejects.toThrow('permissions');
    f.state.refresh.scope = `${READ_SCOPE} ${SEND_SCOPE}`;
    await expect(f.broker.refresh(credential(sending))).resolves.toMatchObject({ sendEnabled: true });
    delete f.state.refresh.scope;
    await expect(f.broker.refresh(credential(sending))).rejects.toThrow('permissions');
  });

  test('authorization check outages fail closed without Google traffic', async () => {
    const f = gmailFixture();
    const connected = await f.connected();
    f.state.allowedFailure = new Error('WorkOS offline');
    f.state.requests = [];
    await expect(f.broker.refresh(credential(connected))).rejects.toThrow('WorkOS offline');
    expect(f.state.requests).toHaveLength(0);
  });
});

describe('managed Gmail disconnect preconditions', () => {
  test('revoke permits old credentials after a move or user removal, without checking current ownership', async () => {
    const f = gmailFixture();
    const connected = await f.connected();
    f.state.rows = [];
    f.state.allowed = false;
    f.state.allowedChecks = [];
    f.state.requests = [];
    await expect(f.broker.revoke(credential(connected))).resolves.toEqual({ revoked: true });
    expect(f.state.allowedChecks).toHaveLength(0);
    expect(f.state.requests).toHaveLength(1);
    const call = f.state.requests[0]!;
    expect(call.url).toBe('https://oauth2.googleapis.com/revoke');
    expect(call.init?.method).toBe('POST');
    expect(call.init?.body).toBe('token=fake-refresh');
    expect(call.init?.redirect).toBe('manual');
  });

  test('only revoke accepts a valid expired capability, without bypassing other checks', async () => {
    const f = gmailFixture();
    const connected = await f.connected();
    f.state.now += 91 * 86_400_000;
    f.state.requests = [];
    f.state.allowedChecks = [];
    f.state.allowed = false;
    f.state.rows = [];
    await expect(f.broker.refresh(credential(connected))).rejects.toThrow('grant');
    expect(f.state.requests).toHaveLength(0);
    await expect(f.broker.revoke(credential(connected))).resolves.toEqual({ revoked: true });
    expect(f.state.requests).toHaveLength(1);
    expect(f.state.allowedChecks).toHaveLength(0);
    for (const changes of [
      { refreshToken: 'different' }, { host: 'other.tail1234.ts.net' }, { refreshGrant: `${connected.refreshGrant}bad` },
    ]) await expect(f.broker.revoke({ ...credential(connected), ...changes })).rejects.toThrow('grant');
    f.state.config = { ...CONFIG, clientId: 'different-client' };
    await expect(f.broker.revoke(credential(connected))).rejects.toThrow('grant');
    f.state.config = { ...CONFIG, grantKey: Buffer.alloc(32, 9) };
    await expect(f.broker.revoke(credential(connected))).rejects.toThrow('grant');
    expect(f.state.requests).toHaveLength(1);
  });

  test('revoke still rejects structurally invalid or future lifetimes', async () => {
    const f = gmailFixture();
    const connected = await f.connected();
    f.state.requests = [];
    for (const claims of [
      { issuedAt: f.state.now + 1 }, { issuedAt: -1 }, { issuedAt: 'now' },
      { expiresAt: f.state.now }, { expiresAt: f.state.now - 1 }, { expiresAt: 'never' },
      { expiresAt: f.state.now + 91 * 86_400_000 }, { expiresAt: Number.MAX_SAFE_INTEGER + 1 },
    ]) await expect(f.broker.revoke({ ...credential(connected), refreshGrant: signed(connected.refreshGrant, claims) })).rejects.toThrow('grant');
    expect(f.state.requests).toHaveLength(0);
  });

  test('revoke refuses a missing, tampered, invalid-lifetime, mismatched token or foreign-host capability', async () => {
    const f = gmailFixture();
    const connected = await f.connected();
    f.state.requests = [];
    for (const over of [
      { refreshGrant: undefined }, { refreshGrant: `${connected.refreshGrant}bad` },
      { refreshToken: 'different' }, { host: 'other.tail1234.ts.net' },
      { refreshGrant: signed(connected.refreshGrant, { expiresAt: f.state.now }) },
    ]) await expect(f.broker.revoke({ ...credential(connected), ...over })).rejects.toThrow();
    expect(f.state.requests).toHaveLength(0);
  });

  test('only an explicit Google 400 invalid_token is already-revoked success', async () => {
    const f = gmailFixture();
    const connected = await f.connected();
    f.state.revokeStatus = 400;
    f.state.revokeBody = JSON.stringify({ error: 'invalid_token', error_description: 'private provider details' });
    await expect(f.broker.revoke(credential(connected))).resolves.toEqual({ revoked: true });
    for (const [status, body] of [
      [401, { error: 'invalid_token' }], [403, { error: 'invalid_token' }], [500, { error: 'invalid_token' }],
      [400, { error: 'invalid_request' }], [400, { error: 'server_error' }], [400, { error: 'INVALID_TOKEN' }],
      [400, { error: { code: 'invalid_token' } }], [400, [{ error: 'invalid_token' }]], [400, null],
      [400, { error_description: 'invalid_token' }],
    ] as const) {
      f.state.revokeStatus = status;
      f.state.revokeBody = JSON.stringify(body);
      await expect(f.broker.revoke(credential(connected))).rejects.toThrow('Google could not revoke this Gmail sign-in. Try again.');
    }
    f.state.revokeStatus = 400;
    f.state.revokeBody = 'invalid_token';
    await expect(f.broker.revoke(credential(connected))).rejects.toThrow('Google could not revoke this Gmail sign-in. Try again.');
    f.state.tokenStatus = 400;
    f.state.refresh = { error: 'invalid_token' };
    await expect(f.broker.refresh(credential(connected))).rejects.toThrow('Google refused this Gmail sign-in. Connect Gmail again.');
  });

  test('revoke errors are generic and a provider redirect is never followed', async () => {
    const f = gmailFixture();
    const connected = await f.connected();
    f.state.revokeStatus = 302;
    await expect(f.broker.revoke(credential(connected))).rejects.toThrow('Google could not revoke this Gmail sign-in. Try again.');
    f.state.failure = new Error('token=fake-refresh private provider details');
    await expect(f.broker.revoke(credential(connected))).rejects.toThrow('Google could not be reached for Gmail sign-in. Try again.');
  });
});
