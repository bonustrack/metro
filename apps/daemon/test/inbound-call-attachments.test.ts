import { afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { CallRoute } from '@metro-labs/core/call';
import { InboundRelay } from '../src/channels/inbound.js';
import { SharedCalls } from '../src/voice/shared.js';

const ROUTE: CallRoute = {
  agentId: 'agent-a', callId: 'call-a', generation: 'generation-a',
  line: 'metro://xmtp/account/chat', from: 'metro://xmtp/account/user/caller',
};
const META = { call_id: ROUTE.callId, call_generation: ROUTE.generation, call_source_id: 'original-message' };
const ATTACH_TIMEOUT_MS = 15_000;
const cleanups: (() => void)[] = [];

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => {
  try {
    for (const cleanup of cleanups.splice(0)) cleanup();
  } finally {
    jest.useRealTimers();
  }
});

function fixture(open = true) {
  const state = { permitted: true, available: true };
  const calls = new SharedCalls(() => state.permitted, () => 'allow');
  const enqueue = mock(() => true);
  const transport = { enqueue, terminate: () => undefined };
  calls.connect({ available: () => state.available, notify: () => true, revoked: () => undefined });
  if (open) expect(calls.open(ROUTE, 'invite', transport)).toBe(true);
  const scope = new Set([ROUTE.agentId]);
  const reads: ReturnType<typeof mock<() => Record<string, string>>>[] = [];
  const bind = mock((event: Record<string, unknown>) => {
    const read = mock(calls.bindChat(event, scope));
    reads.push(read);
    return read;
  });
  const notifs: { method: string; params?: Record<string, unknown> }[] = [];
  const mcp = new Server({ name: 'inbound-call-test', version: '1' });
  mcp.notification = (note) => {
    notifs.push(note);
    return Promise.resolve();
  };
  const relay = new InboundRelay({
    mcp, log: () => undefined, getStations: () => new Set(['xmtp']),
    senderAllowed: () => true, callMeta: bind,
  });
  cleanups.push(() => {
    relay.dropPending();
    calls.disconnect();
    expect(enqueue).not.toHaveBeenCalled();
  });
  return {
    relay, calls, state, transport, scope, bind, reads, notifs,
    meta: (index = 0) => notifs[index]?.params?.meta,
    content: (index = 0) => String(notifs[index]?.params?.content),
  };
}

function message(names = ['report.pdf']): Record<string, unknown> {
  return {
    id: 'original-event', event: { type: 'msg' }, station: 'xmtp',
    line: ROUTE.line, from: ROUTE.from, senderVerified: true,
    ts: new Date().toISOString(), messageId: 'original-message',
    lineName: 'Call chat', fromName: 'Caller', fromDisplayName: 'Caller display',
    text: 'Please read this', replyTo: 'earlier-message', isPrivate: true,
    payload: { attachments: names.map((name) => ({ name })) },
  };
}

function attachment(failed = false, index = 0): Record<string, unknown> {
  return {
    id: `attachment-event-${index}`, event: { type: 'msg' }, station: 'xmtp',
    line: ROUTE.line, from: 'metro://user', messageId: `attachment-message-${index}`,
    ts: new Date().toISOString(),
    payload: {
      contentType: failed ? 'attachmentFailed' : 'attachmentSaved',
      attachmentFor: 'original-event', index, name: 'report.pdf', mime: 'application/pdf',
      ...(failed ? { reason: 'download refused' } : {
        attachmentPath: '/tmp/metro-inbound-call-test-no-file/report.pdf',
        url: 'https://files.test/report.pdf',
      }),
    },
  };
}

type Delivery = 'saved' | 'failed' | 'timeout';
const DELIVERIES: Delivery[] = ['saved', 'failed', 'timeout'];
async function deliver(relay: InboundRelay, mode: Delivery, replay = false): Promise<void> {
  if (mode === 'timeout') jest.advanceTimersByTime(ATTACH_TIMEOUT_MS + 1);
  else await relay.handleEvent(attachment(mode === 'failed'), replay);
}

function noCallMeta(meta: unknown): void {
  expect(meta).not.toHaveProperty('call_id');
  expect(meta).not.toHaveProperty('call_generation');
  expect(meta).not.toHaveProperty('call_source_id');
}

describe('attachment call binding', () => {
  for (const mode of DELIVERIES) {
    test(`${mode} keeps the authenticated original message source and attachment behavior`, async () => {
      const f = fixture();
      const original = message();
      await f.relay.handleEvent(original);
      expect(f.notifs).toHaveLength(0);
      expect(f.bind).toHaveBeenCalledTimes(1);
      expect(f.bind).toHaveBeenCalledWith(original);
      expect(f.reads[0]).not.toHaveBeenCalled();
      await deliver(f.relay, mode);
      expect(f.notifs).toHaveLength(1);
      expect(f.meta()).toMatchObject({
        ...META, line: ROUTE.line, from: ROUTE.from, station: 'xmtp',
        message_id: 'original-message', from_name: 'Caller', line_name: 'Call chat',
        from_display_name: 'Caller display', addressed: 'direct', reply_to: 'earlier-message',
      });
      expect(f.reads[0]).toHaveBeenCalledTimes(1);
      expect(f.bind).toHaveBeenCalledTimes(1);
      expect(f.content()).toStartWith('Please read this\n');
      if (mode === 'saved') {
        expect(f.meta()).toMatchObject({ name: 'report.pdf', mime: 'application/pdf', url: 'https://files.test/report.pdf' });
        expect(f.content()).toContain('[file attachment received: report.pdf');
      } else {
        expect(f.meta()).not.toHaveProperty('url');
        expect(f.meta()).not.toHaveProperty('local_path');
        expect(f.content()).toContain(mode === 'failed' ? 'Reason: download refused' : '[attachment(s) could not be fetched in time: report.pdf]');
      }
      jest.advanceTimersByTime(ATTACH_TIMEOUT_MS + 1);
      expect(f.notifs).toHaveLength(1);
    });

    for (const change of ['revoked', 'replacement', 'permission', 'bridge'] as const) {
      test(`${mode} revalidates after ${change} without rebinding to a new call`, async () => {
        const f = fixture();
        await f.relay.handleEvent(message());
        if (change === 'revoked') f.calls.revoke();
        else if (change === 'replacement') {
          expect(f.calls.open({ ...ROUTE, generation: 'generation-b' }, 'new-invite', f.transport)).toBe(true);
        } else if (change === 'permission') f.state.permitted = false;
        else f.state.available = false;
        await deliver(f.relay, mode);
        expect(f.notifs).toHaveLength(1);
        noCallMeta(f.meta());
        expect(f.meta()).toMatchObject({ message_id: 'original-message', from: ROUTE.from });
        expect(f.bind).toHaveBeenCalledTimes(1);
        expect(f.reads[0]).toHaveBeenCalledTimes(1);
      });
    }

    test(`${mode} never binds replayed original messages`, async () => {
      const f = fixture();
      await f.relay.handleEvent(message(), true);
      await deliver(f.relay, mode);
      expect(f.notifs).toHaveLength(1);
      noCallMeta(f.meta());
      expect(f.bind).not.toHaveBeenCalled();
      expect(f.content()).toStartWith('Please read this\n');
    });

    test(`${mode} cannot gain a call that started after the original message`, async () => {
      const f = fixture(false);
      await f.relay.handleEvent(message());
      expect(f.calls.open(ROUTE, 'later-invite', f.transport)).toBe(true);
      await deliver(f.relay, mode);
      expect(f.notifs).toHaveLength(1);
      noCallMeta(f.meta());
      expect(f.bind).toHaveBeenCalledTimes(1);
      expect(f.calls.valid({ route: ROUTE, sourceId: 'original-message' })).toBe(false);
    });
  }

  test('saved media revalidates after asynchronous note preparation', async () => {
    const f = fixture();
    await f.relay.handleEvent(message());
    const delivery = f.relay.handleEvent(attachment());
    expect(f.reads[0]).not.toHaveBeenCalled();
    f.calls.revoke();
    await delivery;
    expect(f.notifs).toHaveLength(1);
    noCallMeta(f.meta());
    expect(f.reads[0]).toHaveBeenCalledTimes(1);
  });

  test('multiple attachments and a partial timeout reuse one binding and one caption', async () => {
    const f = fixture();
    await f.relay.handleEvent(message(['saved.pdf', 'failed.pdf', 'missing.pdf']));
    await f.relay.handleEvent(attachment());
    await f.relay.handleEvent(attachment(true, 1));
    await deliver(f.relay, 'timeout');
    expect(f.notifs).toHaveLength(3);
    expect(f.bind).toHaveBeenCalledTimes(1);
    expect(f.reads[0]).toHaveBeenCalledTimes(3);
    for (let index = 0; index < 3; index++) expect(f.meta(index)).toMatchObject(META);
    expect(f.content()).toStartWith('Please read this\n');
    expect(f.content(1)).not.toContain('Please read this');
    expect(f.content(2)).toBe('[attachment(s) could not be fetched in time: missing.pdf]');
  });

  test('a call revoked between attachments loses metadata on later deliveries', async () => {
    const f = fixture();
    await f.relay.handleEvent(message(['saved.pdf', 'failed.pdf', 'missing.pdf']));
    await f.relay.handleEvent(attachment());
    f.calls.revoke();
    await f.relay.handleEvent(attachment(true, 1));
    await deliver(f.relay, 'timeout');
    expect(f.meta()).toMatchObject(META);
    noCallMeta(f.meta(1));
    noCallMeta(f.meta(2));
    expect(f.bind).toHaveBeenCalledTimes(1);
    expect(f.reads[0]).toHaveBeenCalledTimes(3);
  });

  for (const failed of [false, true]) {
    test(`standalone ${failed ? 'failure' : 'saved media'} never binds on a known line`, async () => {
      const f = fixture();
      await f.relay.handleEvent(message([]), true);
      await f.relay.handleEvent(attachment(failed));
      expect(f.notifs).toHaveLength(2);
      expect(f.meta(1)).toMatchObject({ from: 'metro://attachment', line: ROUTE.line });
      noCallMeta(f.meta(1));
      expect(f.bind).not.toHaveBeenCalled();
    });

    test(`replayed ${failed ? 'failure' : 'saved media'} cannot use a live pending binding`, async () => {
      const f = fixture();
      await f.relay.handleEvent(message());
      await f.relay.handleEvent(attachment(failed), true);
      expect(f.notifs).toHaveLength(1);
      noCallMeta(f.meta());
      expect(f.bind).toHaveBeenCalledTimes(1);
      expect(f.reads[0]).not.toHaveBeenCalled();
    });
  }

  for (const invalid of [{ senderVerified: false }, { from: 'metro://xmtp/account/user/other' }, { line: 'metro://xmtp/account/other' }]) {
    test(`unbound original ${JSON.stringify(invalid)} stays unbound despite follow-up identity claims`, async () => {
      const f = fixture();
      await f.relay.handleEvent({ ...message(), ...invalid });
      await f.relay.handleEvent({ ...attachment(), from: ROUTE.from, messageId: 'original-message', senderVerified: true });
      noCallMeta(f.meta());
      expect(f.calls.valid({ route: ROUTE, sourceId: 'original-message' })).toBe(false);
      expect(f.bind).toHaveBeenCalledTimes(1);
    });
  }

  test('dropping pending messages drops their bindings and timeouts too', async () => {
    const f = fixture();
    await f.relay.handleEvent(message());
    f.relay.dropPending();
    await deliver(f.relay, 'timeout');
    expect(f.notifs).toHaveLength(0);
    await f.relay.handleEvent(attachment());
    noCallMeta(f.meta());
    expect(f.reads[0]).not.toHaveBeenCalled();
  });
});

describe('non-attachment call binding', () => {
  test('live text uses the same binding factory and evaluates it at delivery', async () => {
    const f = fixture();
    await f.relay.handleEvent(message([]));
    expect(f.meta()).toMatchObject(META);
    expect(f.bind).toHaveBeenCalledTimes(1);
    expect(f.reads[0]).toHaveBeenCalledTimes(1);
  });

  test('replayed text never binds', async () => {
    const f = fixture();
    await f.relay.handleEvent(message([]), true);
    noCallMeta(f.meta());
    expect(f.bind).not.toHaveBeenCalled();
  });

  for (const type of ['system', 'react']) {
    for (const names of [[], ['report.pdf']]) {
      test(`${type} ${names.length ? 'with attachments' : 'without attachments'} never binds`, async () => {
        const f = fixture();
        await f.relay.handleEvent({ ...message(names), event: { type, emoji: 'reaction', targetId: 'target' } });
        if (names.length) await f.relay.handleEvent(attachment());
        expect(f.notifs).toHaveLength(1);
        noCallMeta(f.meta());
        expect(f.bind).not.toHaveBeenCalled();
      });
    }
  }
});
