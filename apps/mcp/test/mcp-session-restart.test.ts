import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createMetroMcp } from '../src/mcp/index.ts';
import { setKeyMap } from '../src/db/key-map.ts';
import { setAgentMap } from '../src/db/agent-map.ts';
import { asLine } from '../src/stations/lines.ts';
import { publishEvent, type MetroEvent } from '../src/daemon/events.ts';

const TOKEN = 'mk_test_agent_key';
setKeyMap([{ key: TOKEN, agentId: 'agent000001' }]);
beforeAll(() => setAgentMap({ 'discord-bot/acc': 'agent000001' }, { ['agent000001']: 'Tony' }));
afterAll(() => setAgentMap({}, {}));


const msgEvent = (text: string): MetroEvent =>
  ({
    id: `id-${randomUUID()}`,
    ts: new Date().toISOString(),
    station: 'discord-bot',
    line: asLine('metro://discord-bot/acc/chan1'),
    from: asLine('metro://discord-bot/acc/sender1'),
    to: asLine('metro://discord-bot/acc/chan1'),
    text,
    messageId: `m-${randomUUID()}`,
    event: { type: 'msg' },
  }) as unknown as MetroEvent;

const sseFrames = (chunk: string): Record<string, unknown>[] => {
  const out: Record<string, unknown>[] = [];
  for (const block of chunk.split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    const json = line.slice(5).trim();
    if (!json) continue;
    try {
      out.push(JSON.parse(json) as Record<string, unknown>);
    } catch {
      // priming / non-JSON frames
    }
  }
  return out;
};

let server: Server | undefined;
let second: Server | undefined;
afterAll(async () => {
  if (server) await new Promise<void>((r) => server?.close(() => r()));
  if (second) await new Promise<void>((r) => second?.close(() => r()));
});

describe('MCP session survives daemon restart', () => {
  test('a request with an unknown/stale session id is adopted (not 404) and notifications then flow', async () => {
    const handler = await createMetroMcp();
    handler.startInbound();
    server = createServer((req, res) => {
      void handler.httpHandler(req, res);
    });
    await new Promise<void>((r) => server?.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/mcp?token=${TOKEN}`;

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
    expect(init.status).toBe(200);
    const liveSessionId = init.headers.get('mcp-session-id');
    expect(typeof liveSessionId).toBe('string');
    const initFrames = sseFrames(await init.text());
    expect(
      (
        initFrames[0]?.result as
          | { capabilities?: { tools?: { listChanged?: boolean } } }
          | undefined
      )?.capabilities?.tools?.listChanged,
    ).toBe(true);

    const staleSessionId = randomUUID();
    expect(staleSessionId).not.toBe(liveSessionId);

    const ac = new AbortController();
    const sseRes = await fetch(url, {
      method: 'GET',
      signal: ac.signal,
      headers: {
        accept: 'text/event-stream',
        'mcp-session-id': staleSessionId,
        'mcp-protocol-version': '2025-06-18',
      },
    });
    expect(sseRes.status).not.toBe(404);
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get('x-accel-buffering')).toBe('no');

    const received: Record<string, unknown>[] = [];
    let raw = '';
    const reader = sseRes.body?.getReader();
    const decoder = new TextDecoder();
    const pump = (async () => {
      if (!reader) return;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          raw += text;
          for (const f of sseFrames(text)) received.push(f);
        }
      } catch {
        // aborted on teardown
      }
    })();

    await new Promise((r) => setTimeout(r, 200));
    publishEvent(msgEvent('after restart'));

    const start = Date.now();
    while (Date.now() - start < 5000) {
      if (
        received.some(
          (f) =>
            f.method === 'notifications/claude/channel' &&
            (f.params as { content?: string } | undefined)?.content ===
              'after restart',
        )
      )
        break;
      await new Promise((r) => setTimeout(r, 25));
    }
    ac.abort();
    await pump;

    expect(raw.includes(':\n\n')).toBe(true);
    expect(
      received.some(
        (f) =>
          f.method === 'notifications/claude/channel' &&
          (f.params as { content?: string } | undefined)?.content ===
            'after restart',
      ),
    ).toBe(true);
    expect(
      received.some((f) => f.method === 'notifications/tools/list_changed'),
    ).toBe(true);
  }, 15000);
});

describe('the tool list_changed notice', () => {
  test('is not sent to a client that just listed the tools itself', async () => {
    const handler = await createMetroMcp();
    handler.startInbound();
    second = createServer((req, res) => {
      void handler.httpHandler(req, res);
    });
    await new Promise<void>((r) => second?.listen(0, '127.0.0.1', () => r()));
    const port = (second.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/mcp?token=${TOKEN}`;

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
    const sessionId = init.headers.get('mcp-session-id') ?? '';
    await init.body?.cancel();
    expect(sessionId).not.toBe('');

    const ac = new AbortController();
    const sseRes = await fetch(url, {
      method: 'GET',
      signal: ac.signal,
      headers: {
        accept: 'text/event-stream',
        'mcp-session-id': sessionId,
        'mcp-protocol-version': '2025-06-18',
      },
    });
    expect(sseRes.status).toBe(200);

    const received: Record<string, unknown>[] = [];
    const reader = sseRes.body?.getReader();
    const decoder = new TextDecoder();
    const pump = (async () => {
      if (!reader) return;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const f of sseFrames(decoder.decode(value, { stream: true })))
            received.push(f);
        }
      } catch {
        // aborted on teardown
      }
    })();

    await new Promise((r) => setTimeout(r, 500));
    ac.abort();
    await pump;

    expect(
      received.some((f) => f.method === 'notifications/tools/list_changed'),
    ).toBe(false);
  }, 15000);
});
