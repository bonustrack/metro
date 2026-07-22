import { afterAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createMetroMcp } from '../src/mcp/index.ts';
import { asLine } from '../src/stations/lines.ts';
import { publishEvent, type MetroEvent } from '../src/daemon/events.ts';

process.env.METRO_CHANNEL_STATIONS = 'discord';

const msgEvent = (text: string): MetroEvent =>
  ({
    id: `id-${randomUUID()}`,
    ts: new Date().toISOString(),
    station: 'discord',
    line: asLine('metro://discord/acc/chan1'),
    from: asLine('metro://discord/acc/sender1'),
    to: asLine('metro://discord/acc/chan1'),
    text,
    messageId: `m-${randomUUID()}`,
    event: { type: 'msg' },
  }) as unknown as MetroEvent;

interface Frame {
  id?: string;
  retry?: string;
  content?: string;
}

const parseFrames = (raw: string): Frame[] => {
  const out: Frame[] = [];
  for (const block of raw.split('\n\n')) {
    if (!block.trim()) continue;
    const frame: Frame = {};
    for (const line of block.split('\n')) {
      if (line.startsWith('id:')) frame.id = line.slice(3).trim();
      else if (line.startsWith('retry:')) frame.retry = line.slice(6).trim();
      else if (line.startsWith('data:')) {
        const json = line.slice(5).trim();
        if (!json) continue;
        try {
          const parsed = JSON.parse(json) as {
            method?: string;
            params?: { content?: string };
          };
          if (parsed.method === 'notifications/claude/channel')
            frame.content = parsed.params?.content;
        } catch {
          // priming / non-JSON frames
        }
      }
    }
    if (frame.id || frame.retry || frame.content) out.push(frame);
  }
  return out;
};

const initSession = async (url: string): Promise<string> => {
  const init = await fetch(url, {
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
  const sessionId = init.headers.get('mcp-session-id');
  await init.body?.cancel();
  if (!sessionId) throw new Error('no session id from initialize');
  return sessionId;
};

interface Stream {
  frames: Frame[];
  raw: () => string;
  stop: () => Promise<void>;
}

const openGet = async (
  url: string,
  sessionId: string,
  lastEventId?: string,
): Promise<Stream> => {
  const ac = new AbortController();
  const headers: Record<string, string> = {
    accept: 'text/event-stream',
    'mcp-session-id': sessionId,
    'mcp-protocol-version': '2025-06-18',
  };
  if (lastEventId) headers['last-event-id'] = lastEventId;
  const res = await fetch(url, { method: 'GET', signal: ac.signal, headers });
  expect(res.status).toBe(200);
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
    stop: async () => {
      ac.abort();
      await pump;
    },
  };
};

const waitFor = async (
  predicate: () => boolean,
  ms = 5000,
): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
};

let server: Server | undefined;
afterAll(async () => {
  if (server) await new Promise<void>((r) => server?.close(() => r()));
});

describe('standalone GET SSE self-heal', () => {
  test('advertises a wide reconnect retry and replays gap events on reconnect', async () => {
    const handler = await createMetroMcp();
    handler.startInbound();
    server = createServer((req, res) => {
      void handler.httpHandler(req, res);
    });
    await new Promise<void>((r) => server?.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/mcp`;

    const sessionId = await initSession(url);

    const first = await openGet(url, sessionId);
    await waitFor(() => first.raw().includes('retry:'));
    expect(first.raw()).toContain('retry: 15000');

    await new Promise((r) => setTimeout(r, 150));
    const live = `live-${randomUUID()}`;
    publishEvent(msgEvent(live));
    await waitFor(() => first.frames.some((f) => f.content === live));
    const delivered = first.frames.find((f) => f.content === live);
    expect(delivered).toBeDefined();
    const lastEventId = delivered?.id;
    expect(typeof lastEventId).toBe('string');

    await first.stop();

    const gap = `gap-${randomUUID()}`;
    publishEvent(msgEvent(gap));
    await new Promise((r) => setTimeout(r, 100));

    const second = await openGet(url, sessionId, lastEventId);
    await waitFor(() => second.frames.some((f) => f.content === gap));
    const gapFrames = second.frames.filter((f) => f.content === gap);
    const liveDup = second.frames.filter((f) => f.content === live);
    await second.stop();

    expect(gapFrames.length).toBe(1);
    expect(liveDup.length).toBe(0);
  }, 15000);
});
