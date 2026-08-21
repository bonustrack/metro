/**
 * The v146 prod leak, end to end over real HTTP.
 *
 * A WhatsApp message on an account owned by agent 34 was delivered live to a
 * 34-scoped stream and buffered in the shared BoundedEventStore; ~60s later an
 * agent-1 client reconnected its GET with a Last-Event-ID from before that frame
 * and the resumption path wrote it straight to agent 1's socket, with no relay
 * log line at all because ChannelRelay was never consulted.
 *
 * There is ONE `_GET_stream` and one session for the whole daemon, so the second
 * agent's `initialize` adopts the session and the first agent's reconnect adopts
 * it back — which is what makes one client's Last-Event-ID address another
 * client's frames in the first place.
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

const TONY_TOKEN = 'mk_leak_tony';
const LISA_TOKEN = 'mk_leak_lisa';
const TONY_ACCOUNT = 'a1-leaktony';
const LISA_ACCOUNT = 'a34-leaklisa';
const TONY_LINE = `metro://whatsapp/${TONY_ACCOUNT}/111@lid`;
const LISA_LINE = `metro://whatsapp/${LISA_ACCOUNT}/222@lid`;


beforeAll(() => {
  setKeyMap([
    { key: TONY_TOKEN, agentId: 1 },
    { key: LISA_TOKEN, agentId: 34 },
  ]);
  setAgentMap(
    { [`whatsapp/${TONY_ACCOUNT}`]: 1, [`whatsapp/${LISA_ACCOUNT}`]: 34 },
    { 1: 'Tony', 34: 'Lisa' },
  );
});

afterAll(async () => {
  setKeyMap([]);
  setAgentMap({}, {});
  if (server) await new Promise<void>((r) => server?.close(() => r()));
});

const whatsappMsg = (line: string, text: string): MetroEvent =>
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

interface Frame {
  id?: string;
  content?: string;
}

const parseFrames = (raw: string): Frame[] => {
  const out: Frame[] = [];
  for (const block of raw.split('\n\n')) {
    if (!block.trim()) continue;
    const f: Frame = {};
    for (const line of block.split('\n')) {
      if (line.startsWith('id:')) f.id = line.slice(3).trim();
      else if (line.startsWith('data:')) {
        try {
          const parsed = JSON.parse(line.slice(5).trim()) as {
            method?: string;
            params?: { content?: string };
          };
          if (parsed.method === 'notifications/claude/channel')
            f.content = parsed.params?.content;
        } catch {
          // priming / non-JSON frames
        }
      }
    }
    if (f.id ?? f.content) out.push(f);
  }
  return out;
};

let server: Server | undefined;
let base = '';

const url = (token: string): string => `${base}/mcp?token=${token}`;

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
  frames: Frame[];
  raw: () => string;
  status: number;
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
  const frames: Frame[] = [];
  let raw = '';
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  const pump = (async () => {
    if (!reader) return;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        raw += decoder.decode(value, { stream: true });
        frames.length = 0;
        for (const f of parseFrames(raw)) frames.push(f);
      }
    } catch {
      // aborted on teardown
    }
  })();
  return {
    frames,
    raw: () => raw,
    status: res.status,
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

const idOf = (s: Stream, content: string): string => {
  const found = s.frames.find((f) => f.content === content);
  if (!found?.id) throw new Error(`no event id for frame ${content}`);
  return found.id;
};

beforeAll(async () => {
  const handler = await createMetroMcp();
  handler.startInbound();
  server = createServer((req, res) => {
    void handler.httpHandler(req, res);
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

describe('SSE resumption across a rebind never crosses agents', () => {
  test('agent 34 frame is not replayed to an agent 1 reconnect, and survives for 34', async () => {
    const tonySession = await initSession(TONY_TOKEN);
    const tonyFirst = await openGet(TONY_TOKEN, tonySession);
    expect(tonyFirst.status).toBe(200);
    await settle();

    const tonyHello = `tony-hello-${randomUUID()}`;
    publishEvent(whatsappMsg(TONY_LINE, tonyHello));
    await waitFor(() => tonyFirst.frames.some((f) => f.content === tonyHello));
    const tonyCursor = idOf(tonyFirst, tonyHello);
    await tonyFirst.stop();

    const lisaSession = await initSession(LISA_TOKEN);
    const lisaFirst = await openGet(LISA_TOKEN, lisaSession);
    expect(lisaFirst.status).toBe(200);
    await settle();

    const lisaHello = `lisa-hello-${randomUUID()}`;
    publishEvent(whatsappMsg(LISA_LINE, lisaHello));
    await waitFor(() => lisaFirst.frames.some((f) => f.content === lisaHello));
    const lisaCursor = idOf(lisaFirst, lisaHello);

    const lisaSecret = `lisa-secret-${randomUUID()}`;
    publishEvent(whatsappMsg(LISA_LINE, lisaSecret));
    await waitFor(() => lisaFirst.frames.some((f) => f.content === lisaSecret));
    expect(lisaFirst.raw()).toContain(lisaSecret);
    await lisaFirst.stop();

    const tonyBack = await openGet(TONY_TOKEN, tonySession, tonyCursor);
    expect(tonyBack.status).toBe(200);
    await settle();
    const tonyBody = tonyBack.raw();
    await tonyBack.stop();

    expect(tonyBody).not.toContain(lisaSecret);
    expect(tonyBody).not.toContain(lisaHello);
    expect(tonyBody).not.toContain(LISA_ACCOUNT);

    const lisaBack = await openGet(LISA_TOKEN, lisaSession, lisaCursor);
    expect(lisaBack.status).toBe(200);
    await waitFor(() => lisaBack.raw().includes(lisaSecret));
    const lisaBody = lisaBack.raw();
    await lisaBack.stop();

    expect(lisaBody).toContain(lisaSecret);
    expect(lisaBody).not.toContain(tonyHello);
  }, 30000);

  test('a forged Last-Event-ID guessed off the shared stream yields nothing', async () => {
    const lisaSession = await initSession(LISA_TOKEN);
    const lisaStream = await openGet(LISA_TOKEN, lisaSession);
    await settle();
    const secret = `forge-target-${randomUUID()}`;
    publishEvent(whatsappMsg(LISA_LINE, secret));
    await waitFor(() => lisaStream.frames.some((f) => f.content === secret));
    await lisaStream.stop();

    const tonySession = await initSession(TONY_TOKEN);
    for (const forged of ['_GET_stream_1', '_GET_stream_2', '_GET_stream_3']) {
      const probe = await openGet(TONY_TOKEN, tonySession, forged);
      await settle();
      const body = probe.raw();
      await probe.stop();
      expect(body).not.toContain(secret);
    }
  }, 30000);

  test('an unauthenticated reconnect is refused before any replay', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'GET',
      headers: {
        accept: 'text/event-stream',
        'mcp-session-id': 'anything',
        'last-event-id': '_GET_stream_1',
      },
    });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('unauthorized');
  }, 15000);
});
