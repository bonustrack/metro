import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createMetroMcp } from '../src/mcp/index.ts';
import { setKeyMap } from '../src/agents/keys.ts';
import { setAgentMap } from '../src/agents/map.ts';
import { asLine } from '@metro-labs/core/lines';
import { publishEvent, type MetroEvent } from '@metro-labs/core/events';
import { initSession, openGet } from './mcp-probe.ts';
import { settle, waitFor } from './wait.ts';

const TOKEN = 'mk_live_events';
const AGENT = 'agent000001';
const ACCOUNT = 'a1-liveevts';
const LINE = `metro://whatsapp/${ACCOUNT}/111@lid`;
const QUIET_MS = 400;

let mcp: Awaited<ReturnType<typeof createMetroMcp>> | undefined;
let server: Server | undefined;
let base = '';

const url = (): string => `${base}/mcp?token=${TOKEN}`;

const say = (text: string): void => {
  publishEvent({
    id: `id-${randomUUID()}`,
    ts: new Date().toISOString(),
    station: 'whatsapp',
    line: asLine(LINE),
    from: asLine(`${LINE}/sender`),
    to: asLine(LINE),
    text,
    messageId: `m-${randomUUID()}`,
    event: { type: 'msg' },
  } as unknown as MetroEvent);
};

const rpc = async (sessionId: string, method: string, params?: Record<string, unknown>): Promise<{ status: number; body: string }> => {
  const res = await fetch(url(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      'mcp-session-id': sessionId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method, ...(params === undefined ? {} : { params }) }),
  });
  return { status: res.status, body: await res.text() };
};

beforeAll(async () => {
  setKeyMap([{ key: TOKEN, agentId: AGENT }]);
  setAgentMap({ [`whatsapp/${ACCOUNT}`]: AGENT }, { [AGENT]: 'Quiet' });
  const handler = await createMetroMcp({ liveEvents: false });
  mcp = handler;
  handler.startInbound();
  server = createServer((req, res) => {
    handler.httpHandler(req, res).catch(() => undefined);
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  setKeyMap([]);
  setAgentMap({}, {});
  if (server) await new Promise<void>((r) => server?.close(() => r()));
});

describe('live messages switched off for the agent', () => {
  test('nothing reaches the session, the tools still answer, and switching back on delivers only what comes after', async () => {
    const sessionId = await initSession(url());
    const stream = await openGet(url(), sessionId);
    await settle(150);

    const quiet = `quiet-${randomUUID()}`;
    say(quiet);
    await settle(QUIET_MS);
    expect(stream.raw()).not.toContain(quiet);

    const tools = await rpc(sessionId, 'tools/list');
    expect(tools.status).toBe(200);
    expect(tools.body).toContain('"send"');
    expect(tools.body).toContain('"react"');
    const accounts = await rpc(sessionId, 'tools/call', { name: 'list_accounts', arguments: {} });
    expect(accounts.status).toBe(200);
    expect(accounts.body).toContain(ACCOUNT);
    expect(accounts.body).not.toContain('"isError":true');

    mcp?.setLiveEvents(true);
    const loud = `loud-${randomUUID()}`;
    say(loud);
    await waitFor(() => stream.raw().includes(loud));
    expect(stream.raw()).toContain(loud);
    expect(stream.raw()).not.toContain(quiet);

    mcp?.setLiveEvents(false);
    const after = `after-${randomUUID()}`;
    say(after);
    await settle(QUIET_MS);
    expect(stream.raw()).not.toContain(after);
    await stream.stop();
  }, 30000);

  test('a reconnect or a new session while off replays nothing that arrived meanwhile, nor after switching back on', async () => {
    mcp?.setLiveEvents(false);
    const sessionId = await initSession(url());
    const first = await openGet(url(), sessionId);
    await settle(150);
    await first.stop();

    const gap = `gap-${randomUUID()}`;
    say(gap);
    await settle(150);

    const second = await openGet(url(), sessionId);
    await settle(QUIET_MS);
    expect(second.raw()).not.toContain(gap);
    await second.stop();

    const fresh = await initSession(url());
    const third = await openGet(url(), fresh);
    const next = `next-${randomUUID()}`;
    say(next);
    await settle(QUIET_MS);
    expect(third.raw()).not.toContain(gap);
    expect(third.raw()).not.toContain(next);

    mcp?.setLiveEvents(true);
    const back = `back-${randomUUID()}`;
    say(back);
    await waitFor(() => third.raw().includes(back));
    expect(third.raw()).toContain(back);
    expect(third.raw()).not.toContain(gap);
    await third.stop();

    const fourth = await openGet(url(), fresh);
    await settle(QUIET_MS);
    expect(fourth.raw()).not.toContain(gap);
    expect(fourth.raw()).not.toContain(next);
    await fourth.stop();
  }, 30000);
});
