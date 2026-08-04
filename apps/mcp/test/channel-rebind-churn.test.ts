/**
 * The churn guard, restated against per-identity sessions.
 *
 * `rebindDecision` is gone. It answered "should the ONE transport be torn down
 * and rebuilt", and its answer to `initialize` was always yes and to any
 * unknown session id was "adopt it" — with one session per daemon that is how
 * one agent took another's channel. `routeSession` answers "which session does
 * this request belong to", and the adopt branch is reachable only for a session
 * id nobody currently owns.
 */
import { describe, expect, test } from 'bun:test';
import {
  routeSession,
  sessionScopeKey,
  type SessionRoute,
  type SessionRouteInput,
} from '../src/mcp/session-route.ts';
import type { RequestIdentity } from '../src/mcp/request-identity.ts';

const TONY: RequestIdentity = { kind: 'agent', agentId: 1 };
const LISA: RequestIdentity = { kind: 'agent', agentId: 34 };
const TONY_OWNER: RequestIdentity = {
  kind: 'google',
  email: 'tony@example.test',
  agentIds: [1],
};
const BOTH: RequestIdentity = {
  kind: 'google',
  email: 'ops@example.test',
  agentIds: [34, 1],
};
const NO_AGENTS: RequestIdentity = {
  kind: 'google',
  email: 'newcomer@example.test',
  agentIds: [],
};

const route = (over: Partial<SessionRouteInput>): SessionRoute =>
  routeSession({
    isInitialize: false,
    presented: undefined,
    ownership: 'none',
    hasOwnSession: false,
    ...over,
  });

describe('session routing', () => {
  test('a genuine initialize always opens a fresh session and never adopts', () => {
    expect(
      route({ isInitialize: true, presented: 'abc', ownership: 'mine' }),
    ).toEqual({ kind: 'create' });
    expect(
      route({ isInitialize: true, presented: 'abc', ownership: 'theirs' }),
    ).toEqual({ kind: 'create' });
  });

  test('a session id nobody owns is adopted (daemon restart resumption)', () => {
    expect(route({ presented: 'stale-id', ownership: 'none' })).toEqual({
      kind: 'create',
      adoptId: 'stale-id',
    });
  });

  test('a request presenting its own session id does NOT churn the session', () => {
    expect(route({ presented: 'mine-id', ownership: 'mine' })).toEqual({
      kind: 'use',
    });
  });

  test('another identity live session id is 404, never adopted, never used', () => {
    expect(route({ presented: 'lisa-id', ownership: 'theirs' })).toEqual({
      kind: 'reject',
      status: 404,
      message: 'Session not found',
    });
  });

  test('no session id falls back to the caller own session when it has one', () => {
    expect(route({ presented: undefined, hasOwnSession: true })).toEqual({
      kind: 'use',
    });
  });

  test('no session id and no session of its own is a 400, not a new session', () => {
    expect(route({ presented: undefined, hasOwnSession: false })).toEqual({
      kind: 'reject',
      status: 400,
      message: 'Bad Request: Mcp-Session-Id header is required',
    });
  });
});

describe('sessionScopeKey', () => {
  test('an agent key and a google session over the same agent never share one', () => {
    expect(sessionScopeKey(TONY_OWNER)).not.toBe(sessionScopeKey(TONY));
  });

  test('two agents never share a session key', () => {
    expect(sessionScopeKey(TONY)).not.toBe(sessionScopeKey(LISA));
  });

  test('a wider scope is a different session from either of its members', () => {
    expect(sessionScopeKey(BOTH)).not.toBe(sessionScopeKey(TONY));
    expect(sessionScopeKey(BOTH)).not.toBe(sessionScopeKey(LISA));
  });

  test('the key is order independent', () => {
    expect(
      sessionScopeKey({
        kind: 'google',
        email: 'ops@example.test',
        agentIds: [1, 34],
      }),
    ).toBe(sessionScopeKey(BOTH));
  });

  test('a session owning no agent is keyed by email, not pooled with every other', () => {
    expect(sessionScopeKey(NO_AGENTS)).toBe(
      'google:agents::newcomer@example.test',
    );
    expect(sessionScopeKey(NO_AGENTS)).not.toBe(
      sessionScopeKey({ kind: 'google', email: 'other@x.test', agentIds: [] }),
    );
  });
});
