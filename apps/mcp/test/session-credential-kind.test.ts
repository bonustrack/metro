/**
 * A session is keyed by the CREDENTIAL that opened it as well as by the agent
 * scope that credential can see.
 *
 * Keying by scope alone collided an `agents.key` identity with a Google session
 * scoped to exactly that one agent: both answered `agents:<id>`, so they were
 * one session, and `closeAgentSession(id)` — the #130 revocation that ends the
 * rotated agent's stream at the wire — logged the browser out as a side effect.
 * A multi-agent Google session survived only because its scope key happened to
 * differ, which is a collision, not a policy.
 *
 * The equality: two identities share a session iff they are the same kind of
 * credential AND cover the same agents — for an `agents.key` that is the agent
 * it belongs to, for a Google session the signed-in email AND its agent id set.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { SessionRegistry } from '../src/mcp/session-registry.ts';
import { sessionScopeKey } from '../src/mcp/session-route.ts';
import type { RawGetSink } from '../src/mcp/raw-get-stream.ts';
import type { RequestIdentity } from '../src/mcp/request-identity.ts';

const TONY_KEY: RequestIdentity = { kind: 'agent', agentId: 1 };
const LISA_KEY: RequestIdentity = { kind: 'agent', agentId: 34 };
const TONY_LOGIN: RequestIdentity = {
  kind: 'google',
  email: 'tony@example.test',
  agentIds: [1],
};
const OPS_LOGIN: RequestIdentity = {
  kind: 'google',
  email: 'ops@example.test',
  agentIds: [34, 1],
};
const OTHER_LOGIN: RequestIdentity = {
  kind: 'google',
  email: 'other@example.test',
  agentIds: [1],
};

const quiet = (): void => undefined;

const fakeSink = (): RawGetSink & { closes: number } => {
  const sink = {
    closed: false,
    closes: 0,
    attach: (): void => undefined,
    close: (): void => {
      sink.closes += 1;
      sink.closed = true;
    },
  };
  return sink;
};

let registry: SessionRegistry | undefined;
const make = (): SessionRegistry => {
  registry = new SessionRegistry(quiet);
  return registry;
};

afterEach(async () => {
  await registry?.closeAll();
  registry = undefined;
});

describe('the session key carries the credential kind', () => {
  test('an agent key and a google login over that one agent are different keys', () => {
    expect(sessionScopeKey(TONY_KEY)).not.toBe(sessionScopeKey(TONY_LOGIN));
  });

  test('the same agent key is always the same session', () => {
    expect(sessionScopeKey(TONY_KEY)).toBe(
      sessionScopeKey({ kind: 'agent', agentId: 1 }),
    );
  });

  test('the same login is the same session, agent id order included', () => {
    expect(
      sessionScopeKey({
        kind: 'google',
        email: 'ops@example.test',
        agentIds: [1, 34],
      }),
    ).toBe(sessionScopeKey(OPS_LOGIN));
  });

  test('two people holding the same grant do not share a session', () => {
    expect(sessionScopeKey(OTHER_LOGIN)).not.toBe(sessionScopeKey(TONY_LOGIN));
  });

  test('a wider login is neither of the single-agent sessions', () => {
    expect(sessionScopeKey(OPS_LOGIN)).not.toBe(sessionScopeKey(TONY_LOGIN));
    expect(sessionScopeKey(OPS_LOGIN)).not.toBe(sessionScopeKey(TONY_KEY));
    expect(sessionScopeKey(OPS_LOGIN)).not.toBe(sessionScopeKey(LISA_KEY));
  });

  test('two agent keys never share a session', () => {
    expect(sessionScopeKey(TONY_KEY)).not.toBe(sessionScopeKey(LISA_KEY));
  });

  test('a login is never the key an agent-key session is closed by', () => {
    const closedByReset = sessionScopeKey({ kind: 'agent', agentId: 1 });
    expect(closedByReset).toBe(sessionScopeKey(TONY_KEY));
    expect(closedByReset).not.toBe(sessionScopeKey(TONY_LOGIN));
    expect(closedByReset).not.toBe(sessionScopeKey(OPS_LOGIN));
  });
});

describe('an agent key and a login over the same agent', () => {
  test('are two live sessions, neither superseding the other', async () => {
    const reg = make();
    const byKey = await reg.create(TONY_KEY);
    const byLogin = await reg.create(TONY_LOGIN);

    expect(reg.size).toBe(2);
    expect(byKey.id).not.toBe(byLogin.id);
    expect(byKey.scopeKey).not.toBe(byLogin.scopeKey);
    expect(reg.get(byKey.id)).toBe(byKey);
    expect(reg.get(byLogin.id)).toBe(byLogin);
  });

  test('neither can attach to the other session id', async () => {
    const reg = make();
    const byKey = await reg.create(TONY_KEY);
    const byLogin = await reg.create(TONY_LOGIN);

    expect(reg.ownership(byKey.id, sessionScopeKey(TONY_LOGIN))).toBe('theirs');
    expect(reg.ownership(byLogin.id, sessionScopeKey(TONY_KEY))).toBe('theirs');
    expect(reg.ownership(byKey.id, sessionScopeKey(TONY_KEY))).toBe('mine');
    expect(reg.ownership(byLogin.id, sessionScopeKey(TONY_LOGIN))).toBe('mine');
  });

  test('each is found by its own key and never by the other', async () => {
    const reg = make();
    const byKey = await reg.create(TONY_KEY);
    const byLogin = await reg.create(TONY_LOGIN);

    expect(reg.forScope(sessionScopeKey(TONY_KEY))).toBe(byKey);
    expect(reg.forScope(sessionScopeKey(TONY_LOGIN))).toBe(byLogin);
    expect(reg.forScope(sessionScopeKey(OTHER_LOGIN))).toBeUndefined();
  });
});

describe('a key reset closes the agent-key session and nothing else', () => {
  test('the login stays open with its stream, the agent key session is gone', async () => {
    const reg = make();
    const byKey = await reg.create(TONY_KEY);
    const keySink = fakeSink();
    byKey.bindSink(keySink, TONY_KEY);
    const byLogin = await reg.create(TONY_LOGIN);
    const loginSink = fakeSink();
    byLogin.bindSink(loginSink, TONY_LOGIN);

    const closed = await reg.closeScope(
      sessionScopeKey({ kind: 'agent', agentId: 1 }),
    );

    expect(closed).toBe(true);
    expect(reg.get(byKey.id)).toBeUndefined();
    expect(keySink.closes).toBe(1);
    expect(keySink.closed).toBe(true);
    expect(reg.get(byLogin.id)).toBe(byLogin);
    expect(loginSink.closed).toBe(false);
    expect(byLogin.streamAttached).toBe(true);
    expect(reg.size).toBe(1);
  });

  test('a multi-agent login is untouched, exactly as before', async () => {
    const reg = make();
    const byKey = await reg.create(TONY_KEY);
    const ops = await reg.create(OPS_LOGIN);
    const opsSink = fakeSink();
    ops.bindSink(opsSink, OPS_LOGIN);

    await reg.closeScope(sessionScopeKey({ kind: 'agent', agentId: 1 }));

    expect(reg.get(byKey.id)).toBeUndefined();
    expect(reg.get(ops.id)).toBe(ops);
    expect(opsSink.closed).toBe(false);
  });

  test('another agent key session is untouched', async () => {
    const reg = make();
    const tony = await reg.create(TONY_KEY);
    const lisa = await reg.create(LISA_KEY);
    const lisaSink = fakeSink();
    lisa.bindSink(lisaSink, LISA_KEY);

    await reg.closeScope(sessionScopeKey({ kind: 'agent', agentId: 1 }));

    expect(reg.get(tony.id)).toBeUndefined();
    expect(reg.get(lisa.id)).toBe(lisa);
    expect(lisaSink.closed).toBe(false);
  });

  test('closing an agent key session nobody holds reports false', async () => {
    const reg = make();
    await reg.create(TONY_LOGIN);
    expect(
      await reg.closeScope(sessionScopeKey({ kind: 'agent', agentId: 1 })),
    ).toBe(false);
    expect(reg.size).toBe(1);
  });

  test('the rotated agent reconnects into a fresh session of its own', async () => {
    const reg = make();
    const before = await reg.create(TONY_KEY);
    await reg.closeScope(sessionScopeKey({ kind: 'agent', agentId: 1 }));
    const after = await reg.create(TONY_KEY);

    expect(after.id).not.toBe(before.id);
    expect(after.scopeKey).toBe(before.scopeKey);
    expect(reg.get(after.id)).toBe(after);
  });
});
