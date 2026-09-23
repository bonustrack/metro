/**
 * A box runs one agent, so the daemon holds one MCP session at a time. These
 * pin what that single slot still has to do, over real HTTP against the real
 * `createMetroMcp`: a new initialize supersedes, an unknown id is adopted,
 * a message sent while the agent was away is replayed, and a line whose
 * account maps to no agent is never delivered.
 */
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

const TOKEN = 'mk_one_tony';
const ACCOUNT = 'a1-onetony';
const STRAY_ACCOUNT = 'a9-unmapped';
const LINE = `metro://whatsapp/${ACCOUNT}/111@lid`;
const STRAY_LINE = `metro://whatsapp/${STRAY_ACCOUNT}/222@lid`;

let server: Server | undefined;
let base = '';

const url = (): string => `${base}/mcp?token=${TOKEN}`;

const msg = (line: string, text: string): MetroEvent =>
  ({
    id: `id-${randomUUID()}`,
    ts: new Date().toISOString(),
    station: 'whatsapp',
    line: asLine(line),
    from: asLine(`${line}/sender`),
    to: asLine(line),
    text,
    messageId: `m-${randomUUID()}`,
    event: { type: 'msg' },
  }) as unknown as MetroEvent;

beforeAll(async () => {
  setKeyMap([{ key: TOKEN, agentId: 'agent000001' }]);
  setAgentMap({ [`whatsapp/${ACCOUNT}`]: 'agent000001' }, { ['agent000001']: 'Tony' });
  const handler = await createMetroMcp();
  handler.startInbound();
  server = createServer((req, res) => {
    void handler.httpHandler(req, res);
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  setKeyMap([]);
  setAgentMap({}, {});
  if (server) await new Promise<void>((r) => server?.close(() => r()));
});

const toolsList = (sessionId?: string): Promise<Response> =>
  fetch(url(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      ...(sessionId === undefined ? {} : { 'mcp-session-id': sessionId }),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  });

describe('one session per box', () => {
  test('a second initialize supersedes the first and ends its stream', async () => {
    const first = await initSession(url());
    const old = await openGet(url(), first);
    await settle(150);
    const second = await initSession(url());
    expect(second).not.toBe(first);
    await waitFor(() => old.ended());
    expect(old.ended()).toBe(true);

    const fresh = await openGet(url(), second);
    await settle(150);
    const text = `after-reinit-${randomUUID()}`;
    publishEvent(msg(LINE, text));
    await waitFor(() => fresh.raw().includes(text));
    expect(fresh.raw()).toContain(text);
    await old.stop();
    await fresh.stop();
  }, 30000);

  test('an unknown session id is adopted, not refused', async () => {
    const stale = randomUUID();
    const res = await toolsList(stale);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBe(stale);
    expect(body).toContain('"tools"');
  }, 30000);

  test('a line whose account maps to no agent is never delivered', async () => {
    const sessionId = await initSession(url());
    const stream = await openGet(url(), sessionId);
    await settle(150);
    const stray = `stray-${randomUUID()}`;
    const mine = `mine-${randomUUID()}`;
    publishEvent(msg(STRAY_LINE, stray));
    publishEvent(msg(LINE, mine));
    await waitFor(() => stream.raw().includes(mine));
    const body = stream.raw();
    await stream.stop();
    expect(body).toContain(mine);
    expect(body).not.toContain(stray);
    expect(body).not.toContain(STRAY_ACCOUNT);
  }, 30000);

  test('a gap message arrives after reconnecting a dropped stream', async () => {
    const sessionId = await initSession(url());
    const first = await openGet(url(), sessionId);
    await settle(150);
    await first.stop();
    await settle(150);

    const gap = `gap-${randomUUID()}`;
    publishEvent(msg(LINE, gap));
    await settle(150);

    const second = await openGet(url(), sessionId);
    await waitFor(() => second.raw().includes(gap));
    const body = second.raw();
    await second.stop();
    expect(body).toContain(gap);
  }, 30000);

  test('a gap message survives a full re-initialize', async () => {
    const firstSession = await initSession(url());
    const first = await openGet(url(), firstSession);
    await settle(150);
    await first.stop();
    await settle(150);

    const gap = `gap-across-init-${randomUUID()}`;
    publishEvent(msg(LINE, gap));
    await settle(150);

    const secondSession = await initSession(url());
    const second = await openGet(url(), secondSession);
    await waitFor(() => second.raw().includes(gap));
    const body = second.raw();
    await second.stop();
    expect(body).toContain(gap);
  }, 30000);
});
