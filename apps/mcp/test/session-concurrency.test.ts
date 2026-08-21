/**
 * The behaviour change per-identity sessions buy: two agents connected AT THE
 * SAME TIME, both receiving their own traffic, neither displacing the other.
 *
 * Before this rework there was one session, one transport and one `_GET_stream`
 * for the whole daemon, so the second agent's `initialize` took the channel and
 * the first silently stopped receiving until it reconnected — which is how
 * Less's Discord messages to Tony were withheld while Lisa held the stream.
 * Everything here runs over real HTTP against the real `createMetroMcp`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createMetroMcp } from '../src/mcp/index.ts';
import { setKeyMap } from '../src/db/key-map.ts';
import { setAgentMap } from '../src/db/agent-map.ts';
import { asLine } from '../src/stations/lines.ts';
import { publishEvent, type MetroEvent } from '../src/daemon/events.ts';

const TONY_TOKEN = 'mk_conc_tony';
const LISA_TOKEN = 'mk_conc_lisa';
const TONY_ACCOUNT = 'a1-conctony';
const LISA_ACCOUNT = 'a34-conclisa';
const TONY_LINE = `metro://whatsapp/${TONY_ACCOUNT}/111@lid`;
const LISA_LINE = `metro://whatsapp/${LISA_ACCOUNT}/222@lid`;

let server: Server | undefined;
let base = '';

const url = (token: string): string => `${base}/mcp?token=${token}`;

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

const initSession = async (token: string): Promise<string> => {
  const res = await fetch(url(token), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'probe', version: '0.0.0' },
      },
    }),
  });
  const sessionId = res.headers.get('mcp-session-id');
  await res.body?.cancel();
  if (!sessionId) throw new Error('no session id from initialize');
  return sessionId;
};

interface Stream {
  raw: () => string;
  status: number;
  ended: () => boolean;
  stop: () => Promise<void>;
}

const openGet = async (
  token: string,
  sessionId: string,
  lastEventId?: string,
): Promise<Stream> => {
  const ac = new AbortController();
  const headers: Record<string, string> = {
    accept: 'text/event-stream',
    'mcp-session-id': sessionId,
    'mcp-protocol-version': '2025-06-18',
  };
  if (lastEventId !== undefined) headers['last-event-id'] = lastEventId;
  const res = await fetch(url(token), {
    method: 'GET',
    signal: ac.signal,
    headers,
  });
  let raw = '';
  let ended = false;
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  const pump = (async () => {
    if (!reader) return;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          ended = true;
          break;
        }
        raw += decoder.decode(value, { stream: true });
      }
    } catch {
      // aborted on teardown
    }
  })();
  return {
    raw: () => raw,
    status: res.status,
    ended: () => ended,
    stop: async () => {
      ac.abort();
      await pump;
    },
  };
};

const waitFor = async (predicate: () => boolean, ms = 5000): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
};

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 150));

beforeAll(async () => {
  setKeyMap([
    { key: TONY_TOKEN, agentId: 'agent000001' },
    { key: LISA_TOKEN, agentId: 'agent000034' },
  ]);
  setAgentMap(
    { [`whatsapp/${TONY_ACCOUNT}`]: 'agent000001', [`whatsapp/${LISA_ACCOUNT}`]: 'agent000034' },
    { ['agent000001']: 'Tony', ['agent000034']: 'Lisa' },
  );
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

describe('two agents connected at once', () => {
  test('both hold a stream and both receive their own traffic concurrently', async () => {
    const tonySession = await initSession(TONY_TOKEN);
    const lisaSession = await initSession(LISA_TOKEN);
    expect(tonySession).not.toBe(lisaSession);

    const tony = await openGet(TONY_TOKEN, tonySession);
    const lisa = await openGet(LISA_TOKEN, lisaSession);
    expect(tony.status).toBe(200);
    expect(lisa.status).toBe(200);
    await settle();

    const forTony: string[] = [];
    const forLisa: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const t = `tony-${i}-${randomUUID()}`;
      const l = `lisa-${i}-${randomUUID()}`;
      forTony.push(t);
      forLisa.push(l);
      publishEvent(msg(TONY_LINE, t));
      publishEvent(msg(LISA_LINE, l));
    }

    await waitFor(
      () =>
        forTony.every((t) => tony.raw().includes(t)) &&
        forLisa.every((l) => lisa.raw().includes(l)),
    );

    const tonyBody = tony.raw();
    const lisaBody = lisa.raw();
    expect(tony.ended()).toBe(false);
    expect(lisa.ended()).toBe(false);
    await tony.stop();
    await lisa.stop();

    for (const t of forTony) {
      expect(tonyBody).toContain(t);
      expect(lisaBody).not.toContain(t);
    }
    for (const l of forLisa) {
      expect(lisaBody).toContain(l);
      expect(tonyBody).not.toContain(l);
    }
    expect(tonyBody).not.toContain(LISA_ACCOUNT);
    expect(lisaBody).not.toContain(TONY_ACCOUNT);
  }, 30000);

  test('a second agent connecting does not displace the first', async () => {
    const tonySession = await initSession(TONY_TOKEN);
    const tony = await openGet(TONY_TOKEN, tonySession);
    await settle();

    const before = `before-${randomUUID()}`;
    publishEvent(msg(TONY_LINE, before));
    await waitFor(() => tony.raw().includes(before));

    const lisaSession = await initSession(LISA_TOKEN);
    const lisa = await openGet(LISA_TOKEN, lisaSession);
    await settle();

    const after = `after-${randomUUID()}`;
    publishEvent(msg(TONY_LINE, after));
    await waitFor(() => tony.raw().includes(after));

    expect(tony.ended()).toBe(false);
    const tonyBody = tony.raw();
    await tony.stop();
    await lisa.stop();

    expect(tonyBody).toContain(before);
    expect(tonyBody).toContain(after);
  }, 30000);

  test('one agent cannot attach to the other live session id', async () => {
    const lisaSession = await initSession(LISA_TOKEN);
    const lisa = await openGet(LISA_TOKEN, lisaSession);
    await settle();

    const secret = `lisa-only-${randomUUID()}`;
    publishEvent(msg(LISA_LINE, secret));
    await waitFor(() => lisa.raw().includes(secret));

    const stolen = await fetch(url(TONY_TOKEN), {
      method: 'GET',
      headers: {
        accept: 'text/event-stream',
        'mcp-session-id': lisaSession,
        'mcp-protocol-version': '2025-06-18',
      },
    });
    const stolenBody = await stolen.text();

    const post = await fetch(url(TONY_TOKEN), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': lisaSession,
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    const postBody = await post.text();

    expect(lisa.ended()).toBe(false);
    const lisaBody = lisa.raw();
    await lisa.stop();

    expect(stolen.status).toBe(404);
    expect(stolenBody).toBe('Session not found');
    expect(stolenBody).not.toContain(secret);
    expect(post.status).toBe(404);
    expect(postBody).not.toContain(secret);
    expect(lisaBody).toContain(secret);
  }, 30000);

  test('re-initializing displaces only your own stream, and ends it at the wire', async () => {
    const lisaSession = await initSession(LISA_TOKEN);
    const lisa = await openGet(LISA_TOKEN, lisaSession);
    const tonyFirst = await initSession(TONY_TOKEN);
    const tonyOld = await openGet(TONY_TOKEN, tonyFirst);
    await settle();

    const tonySecond = await initSession(TONY_TOKEN);
    expect(tonySecond).not.toBe(tonyFirst);
    await waitFor(() => tonyOld.ended());
    expect(tonyOld.ended()).toBe(true);

    const tonyNew = await openGet(TONY_TOKEN, tonySecond);
    await settle();
    const text = `after-reinit-${randomUUID()}`;
    publishEvent(msg(TONY_LINE, text));
    await waitFor(() => tonyNew.raw().includes(text));

    const lisaText = `lisa-still-here-${randomUUID()}`;
    publishEvent(msg(LISA_LINE, lisaText));
    await waitFor(() => lisa.raw().includes(lisaText));

    expect(lisa.ended()).toBe(false);
    expect(tonyNew.raw()).toContain(text);
    expect(lisa.raw()).toContain(lisaText);
    await tonyOld.stop();
    await tonyNew.stop();
    await lisa.stop();
  }, 30000);

  test('a gap message arrives after reconnecting a dropped stream', async () => {
    const tonySession = await initSession(TONY_TOKEN);
    const first = await openGet(TONY_TOKEN, tonySession);
    await settle();
    await first.stop();
    await settle();

    const gap = `gap-${randomUUID()}`;
    publishEvent(msg(TONY_LINE, gap));
    await settle();

    const second = await openGet(TONY_TOKEN, tonySession);
    await waitFor(() => second.raw().includes(gap));
    const body = second.raw();
    await second.stop();
    expect(body).toContain(gap);
  }, 30000);

  test('a gap message survives a full re-initialize of the same agent', async () => {
    const firstSession = await initSession(TONY_TOKEN);
    const first = await openGet(TONY_TOKEN, firstSession);
    await settle();
    await first.stop();
    await settle();

    const gap = `gap-across-init-${randomUUID()}`;
    publishEvent(msg(TONY_LINE, gap));
    await settle();

    const secondSession = await initSession(TONY_TOKEN);
    const second = await openGet(TONY_TOKEN, secondSession);
    await waitFor(() => second.raw().includes(gap));
    const body = second.raw();
    await second.stop();
    expect(body).toContain(gap);
  }, 30000);
});
