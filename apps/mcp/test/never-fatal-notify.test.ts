/**
 * v157 took the whole daemon down at 20:27:31Z — code 1, machine reboot, ~16s
 * of outage across every station — because ONE notification could not be
 * written to a client that had already gone:
 *
 *   error: Not connected
 *     at notification (@modelcontextprotocol/sdk/…/shared/protocol.js:791:23)
 *     at flushPendingFallback (apps/mcp/src/channels/inbound.ts:161:16)
 *     at <anonymous> (apps/mcp/src/channels/inbound.ts:219:19)
 *
 * `bufferAttachments` arms a 15s fallback timer so an attachment that never
 * downloads still surfaces something. The timer callback discarded the promise
 * with a bare `void`, so when the session's transport had gone in the meantime
 * — a superseded `initialize`, an idle reap, a key reset — `mcp.notification()`
 * threw `Not connected` into nothing and Bun killed the process.
 *
 * This is ordinary use, not an edge case: `flushPendingFallback` is the ONLY
 * `InboundRelay` entry point that does not run inside `ChannelRelay.deliver`'s
 * try/catch, and a client that resumes with `last-event-id` routinely leaves a
 * buffered parent whose `attachmentSaved` sat before the resume point.
 *
 * A notification failing because a client vanished is normal. It must never be
 * fatal. These tests pin that at both layers: the timer itself, and the
 * process-level guard behind it.
 */

import { afterEach, describe, expect, jest, test } from 'bun:test';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InboundRelay } from '../src/channels/inbound.ts';

/** Mirrors ATTACH_TIMEOUT_MS in src/channels/inbound.ts (not exported). */
const ATTACH_TIMEOUT_MS = 15_000;

const attachmentMsg = (): Record<string, unknown> => ({
  event: { type: 'msg' },
  id: 'msg_orphan_parent',
  ts: '2026-08-05T20:27:16.000Z',
  station: 'discord-bot',
  line: 'metro://discord-bot/d0/1504226489359401221',
  from: 'metro://discord-bot/d0/user/238307675501232128',
  fromName: 'bonustrack_',
  to: 'metro://user',
  text: 'here is the file',
  messageId: '1534630426356879492',
  payload: {
    account: 'd0',
    attachments: [
      { id: '1', name: 'orphan.pdf', contentType: 'application/pdf' },
    ],
  },
});

async function deadServer(): Promise<Server> {
  const server = new Server(
    { name: 'metro', version: '0.1.0' },
    {
      capabilities: {
        experimental: {
          'claude/channel': {},
          'claude/channel/permission': {},
        },
        tools: { listChanged: true },
      },
    },
  );
  await server.connect(
    new StreamableHTTPServerTransport({ sessionIdGenerator: () => 'gone' }),
  );
  await server.close();
  return server;
}

interface Watch {
  reasons: unknown[];
  stop: () => void;
}

function watchUnhandled(): Watch {
  const reasons: unknown[] = [];
  const onReject = (reason: unknown): void => {
    reasons.push(reason);
  };
  process.on('unhandledRejection', onReject);
  return {
    reasons,
    stop: () => {
      process.off('unhandledRejection', onReject);
    },
  };
}

let watcher: Watch | undefined;

afterEach(() => {
  watcher?.stop();
  watcher = undefined;
  jest.useRealTimers();
});

describe('the 15s attachment fallback fires against a transport that has gone', () => {
  test('the notification rejects, and the rejection is caught rather than fatal', async () => {
    watcher = watchUnhandled();
    const logged: unknown[][] = [];
    const relay = new InboundRelay({
      mcp: await deadServer(),
      log: (...a: unknown[]) => logged.push(a),
      getStations: () => new Set(['discord-bot']),
      senderAllowed: () => true,
    });

    jest.useFakeTimers();
    try {
      await relay.handleEvent(attachmentMsg());
      jest.advanceTimersByTime(ATTACH_TIMEOUT_MS + 1_000);
    } finally {
      jest.useRealTimers();
    }
    await Bun.sleep(50);

    expect(watcher.reasons).toEqual([]);

    const failure = logged.find(
      (line) => String(line[0]) === 'inbound: attachment fallback not delivered',
    );
    expect(failure).toBeDefined();
    const rendered = failure?.map((v) => String(v)).join(' ') ?? '';
    expect(rendered).toContain('Not connected');
  });

  test('the log line carries the buffered id and line, so it can be traced', async () => {
    watcher = watchUnhandled();
    const logged: unknown[][] = [];
    const relay = new InboundRelay({
      mcp: await deadServer(),
      log: (...a: unknown[]) => logged.push(a),
      getStations: () => new Set(['discord-bot']),
      senderAllowed: () => true,
    });

    jest.useFakeTimers();
    try {
      await relay.handleEvent(attachmentMsg());
      jest.advanceTimersByTime(ATTACH_TIMEOUT_MS + 1_000);
    } finally {
      jest.useRealTimers();
    }
    await Bun.sleep(50);

    const failure = logged.find(
      (line) => String(line[0]) === 'inbound: attachment fallback not delivered',
    );
    const rendered = failure?.map((v) => String(v)).join(' ') ?? '';
    expect(rendered).toContain('msg_orphan_parent');
    expect(rendered).toContain('metro://discord-bot/d0/1504226489359401221');
    expect(watcher.reasons).toEqual([]);
  });

  test('a relay whose transport is alive still delivers the fallback', async () => {
    watcher = watchUnhandled();
    const notifs: { method: string; params: Record<string, unknown> }[] = [];
    const relay = new InboundRelay({
      mcp: {
        notification: (n: { method: string; params: Record<string, unknown> }) => {
          notifs.push(n);
          return Promise.resolve();
        },
      } as never,
      log: () => undefined,
      getStations: () => new Set(['discord-bot']),
      senderAllowed: () => true,
    });

    jest.useFakeTimers();
    try {
      await relay.handleEvent(attachmentMsg());
      jest.advanceTimersByTime(ATTACH_TIMEOUT_MS + 1_000);
    } finally {
      jest.useRealTimers();
    }
    await Bun.sleep(50);

    expect(notifs).toHaveLength(1);
    expect(String(notifs[0]?.params.content)).toContain('orphan.pdf');
    expect(watcher.reasons).toEqual([]);
  });

  test('the relay keeps working for the next message after a failed fallback', async () => {
    watcher = watchUnhandled();
    const server = await deadServer();
    const notifs: unknown[] = [];
    const relay = new InboundRelay({
      mcp: server,
      log: () => undefined,
      getStations: () => new Set(['discord-bot']),
      senderAllowed: () => true,
    });

    jest.useFakeTimers();
    try {
      await relay.handleEvent(attachmentMsg());
      jest.advanceTimersByTime(ATTACH_TIMEOUT_MS + 1_000);
    } finally {
      jest.useRealTimers();
    }
    await Bun.sleep(50);

    const revived = new InboundRelay({
      mcp: {
        notification: (n: unknown) => {
          notifs.push(n);
          return Promise.resolve();
        },
      } as never,
      log: () => undefined,
      getStations: () => new Set(['discord-bot']),
      senderAllowed: () => true,
    });
    await revived.handleEvent({
      event: { type: 'msg' },
      id: 'msg_after',
      station: 'discord-bot',
      line: 'metro://discord-bot/d0/1504226489359401221',
      from: 'metro://discord-bot/d0/user/238307675501232128',
      to: 'metro://user',
      text: 'still relaying',
      messageId: '999',
    });

    expect(notifs).toHaveLength(1);
    expect(watcher.reasons).toEqual([]);
  });
});
