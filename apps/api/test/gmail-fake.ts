import { pkcePair } from '@metro-labs/core/stations/oauth';
import { GmailBroker, gmailStateStore, type GmailSession } from '../src/gmail/broker.js';
import type { GmailConfig } from '../src/gmail/config.js';

export const READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
export const HOST = 'agent.tail1234.ts.net';
export const AGENT = 'agent000001';
export const SERVER = 'saved000001';
export const SESSION: GmailSession = {
  userId: 'user_01ABC', sessionId: 'session_01XYZ', organization: 'org_01TESTOWNER000000',
  role: 'member', expiresAt: Date.now() + 60_000,
};
export const CONFIG: GmailConfig = { clientId: 'google-test.apps.googleusercontent.com', clientSecret: 'fake-client-secret', grantKey: Buffer.alloc(32, 7) };
export const PKCE = pkcePair('a'.repeat(43));
export const START = { host: HOST, agentId: AGENT, challenge: PKCE.challenge, mailbox: 'mailbox@example.test', sendEnabled: false };

export function gmailFixture() {
  const state = {
    now: Date.now(),
    config: CONFIG as GmailConfig | null,
    allowed: true,
    allowedFailure: null as Error | null,
    allowedChecks: [] as [string, string][],
    rows: [{ id: SERVER, host: HOST, organization: SESSION.organization }],
    requests: [] as { url: string; init?: RequestInit }[],
    failure: null as Error | null,
    hold: null as Promise<void> | null,
    onRequest: null as (() => void) | null,
    token: { access_token: 'fake-access', refresh_token: 'fake-refresh', token_type: 'Bearer', expires_in: 3600, scope: READ_SCOPE } as Record<string, unknown>,
    refresh: { access_token: 'fake-renewed-access', token_type: 'Bearer', expires_in: 3600, scope: READ_SCOPE } as Record<string, unknown>,
    profile: { emailAddress: 'mailbox@example.test' } as Record<string, unknown>,
    tokenStatus: 200,
    profileStatus: 200,
    revokeStatus: 200,
    revokeBody: '',
  };
  const states = gmailStateStore();
  const broker = new GmailBroker({
    config: () => state.config,
    states,
    now: () => state.now,
    list: (org) => Promise.resolve(state.rows.filter((row) => row.organization === org)),
    allowed: (userId, org) => {
      state.allowedChecks.push([userId, org]);
      return state.allowedFailure === null ? Promise.resolve(state.allowed) : Promise.reject(state.allowedFailure);
    },
    fetch: async (url, init) => {
      state.requests.push({ url, init });
      state.onRequest?.();
      if (state.failure !== null) throw state.failure;
      if (state.hold !== null) await state.hold;
      if (url === 'https://oauth2.googleapis.com/token') {
        const refreshing = new URLSearchParams(String(init?.body)).get('grant_type') === 'refresh_token';
        return Response.json(refreshing ? state.refresh : state.token, { status: state.tokenStatus });
      }
      if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/profile') return Response.json(state.profile, { status: state.profileStatus });
      if (url === 'https://oauth2.googleapis.com/revoke') return new Response(state.revokeBody, { status: state.revokeStatus });
      throw new Error('Unexpected URL: no external network is permitted in these tests');
    },
  });
  const start = (over: Record<string, unknown> = {}, actor = SESSION) => broker.start(actor, { ...START, ...over });
  const exchange = (ticket: string, over: Record<string, unknown> = {}, actor = SESSION) => broker.exchange(actor, {
    state: ticket, code: 'fake-code', verifier: PKCE.verifier, host: HOST, agentId: AGENT, ...over,
  });
  const connected = async (sendEnabled = false) => {
    state.token.scope = sendEnabled ? `${READ_SCOPE} ${SEND_SCOPE}` : READ_SCOPE;
    return exchange((await start({ sendEnabled })).state);
  };
  return { state, states, broker, start, exchange, connected };
}

export const credential = (tokens: { refreshToken: string; refreshGrant: string }) => ({ refreshToken: tokens.refreshToken, refreshGrant: tokens.refreshGrant, host: HOST });
