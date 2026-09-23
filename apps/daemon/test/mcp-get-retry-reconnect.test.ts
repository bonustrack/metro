import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createMetroMcp } from '../src/mcp/index.ts';
import { setKeyMap } from '../src/agents/keys.ts';
import { setAgentMap } from '../src/agents/map.ts';
import { asLine } from '@metro-labs/core/lines';
import { publishEvent, type MetroEvent } from '@metro-labs/core/events';
import { initSession, openGet } from './mcp-probe.ts';
import { settle, waitFor } from './wait.ts';

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
    const url = `http://127.0.0.1:${port}/mcp?token=${TOKEN}`;

    const sessionId = await initSession(url);

    const first = await openGet(url, sessionId);
    expect(first.status).toBe(200);
    await waitFor(() => first.raw().includes('retry:'));
    expect(first.raw()).toContain('retry: 15000');

    await settle(150);
    const live = `live-${randomUUID()}`;
    publishEvent(msgEvent(live));
    await waitFor(() => parseFrames(first.raw()).some((f) => f.content === live));
    const delivered = parseFrames(first.raw()).find((f) => f.content === live);
    expect(delivered).toBeDefined();
    const lastEventId = delivered?.id;
    expect(typeof lastEventId).toBe('string');

    await first.stop();

    const gap = `gap-${randomUUID()}`;
    publishEvent(msgEvent(gap));
    await settle(100);

    const second = await openGet(url, sessionId, lastEventId);
    expect(second.status).toBe(200);
    await waitFor(() => parseFrames(second.raw()).some((f) => f.content === gap));
    const gapFrames = parseFrames(second.raw()).filter((f) => f.content === gap);
    const liveDup = parseFrames(second.raw()).filter((f) => f.content === live);
    await second.stop();

    expect(gapFrames.length).toBe(1);
    expect(liveDup.length).toBe(0);
  }, 15000);
});
