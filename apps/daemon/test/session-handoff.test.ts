import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { asLine } from '@metro-labs/core/lines';
import { publishEvent } from '@metro-labs/core/events';
import { setAgentMap } from '../src/agents/map.ts';
import { SessionSlot } from '../src/mcp/session-slot.ts';
import { serveChannelGet } from '../src/mcp/raw-get-stream.ts';
import type { McpSession } from '../src/mcp/session.ts';
import { settle, waitFor } from './wait.ts';

const identity = { kind: 'agent', agentId: 'agent000001' } as const;
const line = asLine('metro://whatsapp/handoff-test/111@lid');

beforeEach(() => setAgentMap({ 'whatsapp/handoff-test': identity.agentId }, {}));
afterEach(() => setAgentMap({}, {}));

const emit = (text: string): void => publishEvent({
  id: text,
  ts: new Date().toISOString(),
  station: 'whatsapp',
  line,
  from: asLine(`${line}/sender`),
  to: line,
  text,
  messageId: text,
  event: { type: 'msg' },
});

async function attach(session: McpSession): Promise<() => string> {
  const out = new PassThrough();
  let body = '';
  out.on('data', (chunk: Buffer) => { body += chunk.toString(); });
  const res = out as unknown as ServerResponse;
  res.writeHead = () => res;
  res.flushHeaders = () => undefined;
  const req = new EventEmitter() as IncomingMessage;
  req.headers = { 'mcp-session-id': session.id, accept: 'text/event-stream' };
  req.method = 'GET';
  const served = await serveChannelGet({
    transport: session.transport,
    eventStore: session.eventStore,
    scope: session.scope,
    req,
    res,
    previous: () => session.currentSink,
    registerSink: (sink) => session.bindSink(sink),
    log: () => undefined,
  });
  if (served) session.replayMissed();
  return () => body;
}

function hold(session: McpSession, delivered = false): { entered: Promise<void>; release: () => void } {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const handle = session.relay.handleEvent.bind(session.relay);
  session.relay.handleEvent = async (event, replay) => {
    if (delivered) await handle(event, replay);
    entered.resolve();
    await release.promise;
    if (!delivered) await handle(event, replay);
  };
  return { entered: entered.promise, release: () => release.resolve() };
}

const occurrences = (body: string, text: string): number => body.split(`"content":"${text}"`).length - 1;

describe('pending events across the real session and stream lifecycle', () => {
  test('the first replacement stream receives the old failed and withheld queue exactly once without another replay', async () => {
    const slot = new SessionSlot();
    slot.startInbound();
    const old = await slot.open(identity, 'handoff-old');
    const oldBody = await attach(old);
    emit('handoff-delivered');
    await waitFor(() => oldBody().includes('handoff-delivered'));
    const blocked = hold(old);
    try {
      emit('handoff-in-flight');
      await blocked.entered;
      emit('handoff-queued');
      const fresh = await slot.open(identity, 'handoff-fresh');
      const body = await attach(fresh);
      expect(old.streamAttached).toBe(false);
      expect(fresh.streamAttached).toBe(true);
      expect(body()).not.toContain('handoff-queued');
      emit('handoff-live');
      await waitFor(() => body().includes('handoff-live'));
      blocked.release();
      await waitFor(() => body().includes('handoff-queued'), 1000);
      await settle(40);
      expect(occurrences(body(), 'handoff-in-flight')).toBe(1);
      expect(occurrences(body(), 'handoff-queued')).toBe(1);
      expect(occurrences(body(), 'handoff-live')).toBe(1);
      expect(body()).not.toContain('handoff-delivered');
    } finally {
      blocked.release();
      await slot.close();
    }
  });

  test('an in-flight delivery that succeeds stays consumed while its queued successor is handed off', async () => {
    const slot = new SessionSlot();
    slot.startInbound();
    const old = await slot.open(identity, 'handoff-success-old');
    const oldBody = await attach(old);
    const blocked = hold(old, true);
    try {
      emit('handoff-success-in-flight');
      await blocked.entered;
      expect(occurrences(oldBody(), 'handoff-success-in-flight')).toBe(1);
      emit('handoff-success-queued');
      const fresh = await slot.open(identity, 'handoff-success-fresh');
      const body = await attach(fresh);
      blocked.release();
      await waitFor(() => body().includes('handoff-success-queued'));
      expect(body()).not.toContain('handoff-success-in-flight');
      expect(occurrences(body(), 'handoff-success-queued')).toBe(1);
    } finally {
      blocked.release();
      await slot.close();
    }
  });

  test('a queue draining after another replacement hands off only to the latest stream', async () => {
    const slot = new SessionSlot();
    slot.startInbound();
    const old = await slot.open(identity, 'handoff-first');
    await attach(old);
    const blocked = hold(old);
    try {
      emit('handoff-latest-in-flight');
      await blocked.entered;
      emit('handoff-latest-queued');
      const middle = await slot.open(identity, 'handoff-middle');
      const middleBody = await attach(middle);
      const latest = await slot.open(identity, 'handoff-latest');
      const body = await attach(latest);
      blocked.release();
      await waitFor(() => body().includes('handoff-latest-queued'));
      expect(middle.streamAttached).toBe(false);
      expect(middleBody()).not.toContain('handoff-latest-queued');
      expect(occurrences(body(), 'handoff-latest-in-flight')).toBe(1);
      expect(occurrences(body(), 'handoff-latest-queued')).toBe(1);
    } finally {
      blocked.release();
      await slot.close();
    }
  });

  test('handoff rechecks the new session scope, including account ownership changes while queued', async () => {
    const slot = new SessionSlot();
    slot.startInbound();
    const old = await slot.open(identity, 'handoff-scope-old');
    await attach(old);
    const blocked = hold(old);
    try {
      emit('handoff-private-in-flight');
      await blocked.entered;
      emit('handoff-private-queued');
      const fresh = await slot.open(identity, 'handoff-scope-fresh');
      const body = await attach(fresh);
      setAgentMap({ 'whatsapp/handoff-test': 'agent000002' }, {});
      blocked.release();
      await settle(40);
      expect(body()).not.toContain('handoff-private');
      const owner = await slot.open({ kind: 'agent', agentId: 'agent000002' }, 'handoff-scope-owner');
      const ownerBody = await attach(owner);
      await waitFor(() => ownerBody().includes('handoff-private-queued'));
      expect(occurrences(ownerBody(), 'handoff-private-in-flight')).toBe(1);
      expect(occurrences(ownerBody(), 'handoff-private-queued')).toBe(1);
    } finally {
      blocked.release();
      await slot.close();
    }
  });

  test('live-off suppresses deferred handoff, and live-on never replays that old queue', async () => {
    const slot = new SessionSlot();
    slot.startInbound();
    const old = await slot.open(identity, 'handoff-off-old');
    await attach(old);
    const blocked = hold(old);
    try {
      emit('handoff-off-in-flight');
      await blocked.entered;
      emit('handoff-off-queued');
      const fresh = await slot.open(identity, 'handoff-off-fresh');
      const body = await attach(fresh);
      slot.setLive(false);
      blocked.release();
      await settle(40);
      expect(body()).not.toContain('handoff-off');
      slot.setLive(true);
      fresh.dropStream();
      const nextBody = await attach(fresh);
      emit('handoff-back-live');
      await waitFor(() => nextBody().includes('handoff-back-live'));
      expect(nextBody()).not.toContain('handoff-off');
    } finally {
      blocked.release();
      await slot.close();
    }
  });

  test('a close followed by an open without a stream preserves pending events until a GET attaches', async () => {
    const slot = new SessionSlot();
    slot.startInbound();
    const old = await slot.open(identity, 'handoff-detached-old');
    await attach(old);
    const blocked = hold(old);
    try {
      emit('handoff-detached-in-flight');
      await blocked.entered;
      emit('handoff-detached-queued');
      await slot.close();
      const fresh = await slot.open(identity, 'handoff-detached-fresh');
      blocked.release();
      await settle(40);
      expect(fresh.streamAttached).toBe(false);
      const body = await attach(fresh);
      await waitFor(() => body().includes('handoff-detached-queued'));
      expect(occurrences(body(), 'handoff-detached-in-flight')).toBe(1);
      expect(occurrences(body(), 'handoff-detached-queued')).toBe(1);
    } finally {
      blocked.release();
      await slot.close();
    }
  });
});
