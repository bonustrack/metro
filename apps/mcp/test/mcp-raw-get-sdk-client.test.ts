import { afterAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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

let server: Server | undefined;
afterAll(async () => {
  if (server) await new Promise<void>((r) => server?.close(() => r()));
});

describe('real SDK client over raw GET SSE', () => {
  test('a burst of N channel notifications all arrive in order; tool call still works', async () => {
    const handler = await createMetroMcp();
    handler.startInbound();
    server = createServer((req, res) => {
      void handler.httpHandler(req, res);
    });
    await new Promise<void>((r) => server?.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    const url = new URL(`http://127.0.0.1:${port}/mcp`);

    const received: string[] = [];
    const client = new Client({ name: 'burst-probe', version: '0.0.0' });
    client.fallbackNotificationHandler = (n: {
      method?: string;
      params?: { content?: string };
    }): Promise<void> => {
      if (n.method === 'notifications/claude/channel') {
        const content = n.params?.content;
        if (typeof content === 'string') received.push(content);
      }
      return Promise.resolve();
    };

    const transport = new StreamableHTTPClientTransport(url);
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThan(0);

    await new Promise((r) => setTimeout(r, 250));

    const N = 25;
    const expected: string[] = [];
    for (let i = 0; i < N; i += 1) {
      const text = `burst-${i}`;
      expected.push(text);
      publishEvent(msgEvent(text));
    }

    const start = Date.now();
    while (Date.now() - start < 8000) {
      if (expected.every((e) => received.includes(e))) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    const got = received.filter((c) => c.startsWith('burst-'));
    expect(got).toEqual(expected);

    await client.close();
  }, 20000);
});
