/**
 * Session lifetime: creation, supersession within one identity, idle reaping,
 * the capacity ceiling, and the ownership predicate that decides whether a
 * presented session id is yours, somebody else's, or nobody's.
 *
 * The security-relevant line is `ownership`: 'theirs' must never become a route
 * to that session, and the adopt branch must be reachable only for 'none'.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  MAX_SESSIONS,
  SESSION_IDLE_MS,
  SessionCapacityError,
  SessionRegistry,
} from '../src/mcp/session-registry.ts';
import { sessionScopeKey } from '../src/mcp/session-route.ts';
import type { RawGetSink } from '../src/mcp/raw-get-stream.ts';
import type { RequestIdentity } from '../src/mcp/request-identity.ts';

const TONY: RequestIdentity = { kind: 'agent', agentId: 'agent000001' };
const LISA: RequestIdentity = { kind: 'agent', agentId: 'agent000034' };
const TONY_OWNER: RequestIdentity = {
  kind: 'session',
  subject: 'tony@example.test',
  agentIds: ['agent000001'],
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

describe('session registry', () => {
  test('two identities get two live sessions with different ids', async () => {
    const reg = make();
    const tony = await reg.create(TONY);
    const lisa = await reg.create(LISA);
    expect(reg.size).toBe(2);
    expect(tony.id).not.toBe(lisa.id);
    expect(tony.scopeKey).not.toBe(lisa.scopeKey);
    expect(reg.get(tony.id)).toBe(tony);
    expect(reg.get(lisa.id)).toBe(lisa);
  });

  test('ownership tells mine from theirs from nobody', async () => {
    const reg = make();
    const tony = await reg.create(TONY);
    const lisa = await reg.create(LISA);
    expect(reg.ownership(tony.id, sessionScopeKey(TONY))).toBe('mine');
    expect(reg.ownership(tony.id, sessionScopeKey(TONY_OWNER))).toBe('mine');
    expect(reg.ownership(tony.id, sessionScopeKey(LISA))).toBe('theirs');
    expect(reg.ownership(lisa.id, sessionScopeKey(TONY))).toBe('theirs');
    expect(reg.ownership(randomUUID(), sessionScopeKey(TONY))).toBe('none');
    expect(reg.ownership(undefined, sessionScopeKey(TONY))).toBe('none');
  });

  test('a second session for the same identity supersedes the first', async () => {
    const reg = make();
    const first = await reg.create(TONY);
    const sink = fakeSink();
    first.bindSink(sink, TONY);
    const second = await reg.create(TONY);

    expect(second).not.toBe(first);
    expect(reg.size).toBe(1);
    expect(reg.get(first.id)).toBeUndefined();
    expect(reg.get(second.id)).toBe(second);
    expect(sink.closes).toBe(1);
    expect(sink.closed).toBe(true);
  });

  test('a session for another identity never displaces a live one', async () => {
    const reg = make();
    const tony = await reg.create(TONY);
    const sink = fakeSink();
    tony.bindSink(sink, TONY);
    await reg.create(LISA);

    expect(reg.size).toBe(2);
    expect(reg.get(tony.id)).toBe(tony);
    expect(sink.closes).toBe(0);
    expect(tony.streamAttached).toBe(true);
  });

  test('a stale session id is adopted as the caller own new session', async () => {
    const reg = make();
    const stale = randomUUID();
    const session = await reg.create(TONY, stale);
    expect(session.id).toBe(stale);
    expect(reg.get(stale)).toBe(session);
    expect(reg.ownership(stale, sessionScopeKey(LISA))).toBe('theirs');
  });

  test('an idle session with no stream is reaped, one holding a stream is not', async () => {
    const reg = make();
    const idle = await reg.create(TONY);
    const held = await reg.create(LISA);
    held.bindSink(fakeSink(), LISA);

    expect(reg.sweep(Date.now())).toBe(0);
    expect(reg.size).toBe(2);

    expect(reg.sweep(Date.now() + SESSION_IDLE_MS + 1)).toBe(1);
    expect(reg.get(idle.id)).toBeUndefined();
    expect(reg.get(held.id)).toBe(held);
  });

  test('touch keeps an otherwise idle session alive', async () => {
    const reg = make();
    const session = await reg.create(TONY);
    const later = Date.now() + SESSION_IDLE_MS + 1;
    session.lastSeenAt = later;
    expect(reg.sweep(later)).toBe(0);
    expect(reg.get(session.id)).toBe(session);
  });

  test('the capacity ceiling evicts the least recently used streamless session', async () => {
    const reg = make();
    const first = await reg.create({ kind: 'agent', agentId: 'agent000001' });
    first.lastSeenAt = 0;
    for (let i = 2; i <= MAX_SESSIONS; i += 1)
      await reg.create({ kind: 'agent', agentId: i });
    expect(reg.size).toBe(MAX_SESSIONS);

    await reg.create({ kind: 'agent', agentId: MAX_SESSIONS + 1 });
    expect(reg.size).toBe(MAX_SESSIONS);
    expect(reg.get(first.id)).toBeUndefined();
  }, 20000);

  test('a daemon full of live streams refuses a new session rather than dropping one', async () => {
    const reg = make();
    for (let i = 1; i <= MAX_SESSIONS; i += 1) {
      const s = await reg.create({ kind: 'agent', agentId: i });
      s.bindSink(fakeSink(), { kind: 'agent', agentId: i });
    }
    expect(
      reg.create({ kind: 'agent', agentId: MAX_SESSIONS + 1 }),
    ).rejects.toBeInstanceOf(SessionCapacityError);
    expect(reg.size).toBe(MAX_SESSIONS);
  }, 20000);

  test('a transport that closes itself (an MCP DELETE) evicts the session', async () => {
    const reg = make();
    const session = await reg.create(TONY);
    await session.transport.close();
    await new Promise((r) => setTimeout(r, 10));
    expect(reg.get(session.id)).toBeUndefined();
    expect(reg.size).toBe(0);
  });

  test('closeAll drops every session and closes every stream', async () => {
    const reg = make();
    const tony = await reg.create(TONY);
    const sink = fakeSink();
    tony.bindSink(sink, TONY);
    await reg.create(LISA);

    await reg.closeAll();
    expect(reg.size).toBe(0);
    expect(sink.closed).toBe(true);
  });
});
