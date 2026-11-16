import { describe, expect, spyOn, test } from 'bun:test';
import { log } from '@metro-labs/core/log';
import { CHURN_MAX, SessionSlot } from '../src/mcp/session-slot.ts';
import type { RawGetSink } from '../src/mcp/raw-get-stream.ts';

const identity = { kind: 'agent', agentId: 'agent000001' } as const;

const sink = (): RawGetSink => {
  const stream: RawGetSink = {
    closed: false,
    attach: () => undefined,
    diagnostics: () => ({ tag: 'fixture', openedAt: new Date().toISOString(), attachedAt: null, closedAt: null, ownsMapping: !stream.closed }),
    close: () => {
      stream.closed = true;
    },
  };
  return stream;
};

describe('the shared inbound session slot', () => {
  test('concurrent opens close the superseded session rather than orphan its stream', async () => {
    const slot = new SessionSlot();
    const stream = sink();
    const first = slot.open(identity).then((session) => {
      session.bindSink(stream);
      return session;
    });
    const second = slot.open(identity);
    const sessions = await Promise.all([first, second]);
    try {
      expect(slot.current).toBe(sessions[1]);
      expect(stream.closed).toBe(true);
      expect(sessions[0]?.streamAttached).toBe(false);
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
      await slot.close();
    }
  });

  test('concurrent requests adopting the same id reuse one session', async () => {
    const slot = new SessionSlot();
    const sessions = await Promise.all([slot.open(identity, 'restarted'), slot.open(identity, 'restarted')]);
    try {
      expect(sessions[0] === sessions[1]).toBe(true);
      expect(slot.current).toBe(sessions[0]);
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
      await slot.close();
    }
  });

  test('closing during an open leaves no late installed session', async () => {
    const slot = new SessionSlot();
    const opening = slot.open(identity);
    await slot.close();
    const session = await opening;
    try {
      expect(slot.current?.id).toBeUndefined();
    } finally {
      await session.close();
      await slot.close();
    }
  });

  test('a GET finishing replay after its session closed is ended, not attached', async () => {
    const slot = new SessionSlot();
    const session = await slot.open(identity);
    await slot.close();
    const abandoned = sink();
    try {
      session.bindSink(abandoned);
      expect(abandoned.closed).toBe(true);
      expect(session.streamAttached).toBe(false);
    } finally {
      abandoned.close();
    }
  });

  test('opening the slot again replaces the main stream even with live events enabled (routing keeps other clients out)', async () => {
    const slot = new SessionSlot();
    const main = await slot.open(identity);
    const stream = sink();
    main.bindSink(stream);
    try {
      const worker = await slot.open(identity);
      expect(stream.closed).toBe(true);
      expect(slot.current).toBe(worker);
      expect(slot.liveEvents).toBe(true);
      expect(worker.streamAttached).toBe(false);
    } finally {
      await main.close();
      await slot.close();
    }
  });

  test('a session replaced again and again within a minute warns once', async () => {
    let at = 5_000_000;
    const slot = new SessionSlot(true, () => at);
    const warn = spyOn(log, 'warn');
    try {
      for (let i = 0; i < CHURN_MAX * 2; i++) {
        await slot.open(identity);
        at += 1_000;
      }
      const churn = warn.mock.calls.filter((call) => String(call[1]).includes('replaced again and again'));
      expect(churn.length).toBe(1);
      at += 120_000;
      for (let i = 0; i < 2; i++) await slot.open(identity);
      expect(warn.mock.calls.filter((call) => String(call[1]).includes('replaced again and again')).length).toBe(1);
    } finally {
      warn.mockRestore();
      await slot.close();
    }
  });
});
