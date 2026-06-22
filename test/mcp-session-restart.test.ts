import { afterAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createMetroMcp } from '../src/mcp/index.ts';
import { publishEvent } from '../src/event-bus.ts';
import { asLine } from '../src/lines.ts';
import type { MetroEvent } from '../src/events.ts';

process.env.METRO_CHANNEL_ALLOWLIST = '*';
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
afterAll(async () => {
  if (server) await new Promise<void>((r) => server?.close(() => r()));
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
    const url = `http://127.0.0.1:${port}/mcp`;

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
    await init.body?.cancel();

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

    expect(
      received.some(
        (f) =>
          f.method === 'notifications/claude/channel' &&
          (f.params as { content?: string } | undefined)?.content ===
            'after restart',
      ),
    ).toBe(true);
  }, 15000);
});
