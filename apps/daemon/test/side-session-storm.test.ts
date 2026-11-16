import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMetroMcp } from '../src/mcp/index.ts';
import { setKeyMap } from '../src/agents/keys.ts';
import { setAgentMap } from '../src/agents/map.ts';
import { asLine } from '@metro-labs/core/lines';
import { publishEvent, type MetroEvent } from '@metro-labs/core/events';
import { settle, waitFor } from './wait.ts';

const TOKEN = 'mk_storm_rosa';
const LINE = 'metro://discord-bot/acc/chan1';
const RECONNECT = { initialReconnectionDelay: 500, maxReconnectionDelay: 5_000, reconnectionDelayGrowFactor: 1.5, maxRetries: 900 };

const chat = (text: string): MetroEvent =>
  ({
    id: `id-${randomUUID()}`,
    ts: new Date().toISOString(),
    station: 'discord-bot',
    line: asLine(LINE),
    from: asLine('metro://discord-bot/acc/sender1'),
    to: asLine(LINE),
    text,
    messageId: `m-${randomUUID()}`,
    event: { type: 'msg' },
  }) as unknown as MetroEvent;

let server: Server | undefined;
let url = '';

beforeAll(async () => {
  setKeyMap([{ key: TOKEN, agentId: 'agent000001' }]);
  setAgentMap({ 'discord-bot/acc': 'agent000001' }, { ['agent000001']: 'Rosa' });
  const handler = await createMetroMcp();
  handler.startInbound();
  server = createServer((req, res) => {
    void handler.httpHandler(req, res);
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp?token=${TOKEN}`;
});

afterAll(async () => {
  setKeyMap([]);
  setAgentMap({}, {});
  if (server) await new Promise<void>((r) => server?.close(() => r()));
});

const post = (body: unknown, sessionId?: string): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      ...(sessionId === undefined ? {} : { 'mcp-session-id': sessionId }),
    },
    body: JSON.stringify(body),
  });

async function scriptCall(n: number): Promise<number> {
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Python-urllib', version: '3.12' } } });
  const id = init.headers.get('mcp-session-id') ?? undefined;
  await init.text();
  const listed = await post({ jsonrpc: '2.0', id: n, method: 'tools/list' }, id);
  await listed.text();
  return listed.status;
}

describe('a script on the box next to the real runner client', () => {
  test('a script that initializes before every call never moves the runner, and every chat message arrives', async () => {
    const received: string[] = [];
    const runner = new Client({ name: 'metro-sdk-runner', version: '0.1.0' });
    runner.fallbackNotificationHandler = (n): Promise<void> => {
      const content = n.params?.content;
      if (n.method === 'notifications/claude/channel' && typeof content === 'string') received.push(content);
      return Promise.resolve();
    };
    const transport = new StreamableHTTPClientTransport(new URL(url), { reconnectionOptions: RECONNECT });
    await runner.connect(transport);
    await runner.listTools();
    await settle(300);
    const sessionBefore = transport.sessionId;
    const logged = spyOn(console, 'error');
    const expected: string[] = [];
    try {
      for (let i = 0; i < 15; i++) {
        expect(await scriptCall(i + 2)).toBe(200);
        const text = `during-the-crawl-${String(i)}`;
        expected.push(text);
        publishEvent(chat(text));
      }
      await waitFor(() => expected.every((text) => received.includes(text)), 8000);
      expect(expected.filter((text) => !received.includes(text))).toEqual([]);
      expect(transport.sessionId).toBe(sessionBefore);
      const replaced = logged.mock.calls.filter((call) => call[1] === 'session: opened');
      expect(replaced).toHaveLength(0);
      expect((await runner.listTools()).tools.length).toBeGreaterThan(0);
    } finally {
      logged.mockRestore();
      await runner.close();
    }
  }, 30000);
});
