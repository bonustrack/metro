import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import WebSocket from 'ws';
import { makeEmit, startWebhookServer } from '../src/daemon/http.ts';
import { mintTerminalTicket, pendingTerminalTickets, takeTerminalTicket } from '../src/daemon/terminal-tickets.ts';
import { auth, TEST_STRANGER } from './identity-helper.ts';

const OWNER = '0xef8305e140ac520225daf050e2f71d5fbcc543e7';
let server: Server;
let base = '';
const saved = { host: process.env.METRO_HTTP_HOST, port: process.env.METRO_WEBHOOK_PORT };

beforeAll(async () => {
  process.env.METRO_HTTP_HOST = '127.0.0.1';
  process.env.METRO_WEBHOOK_PORT = String(10000 + Math.floor(Math.random() * 20000));
  server = await startWebhookServer(makeEmit(), {
    terminalApi: {
      authorize: (subject) => {
        if (subject !== OWNER) throw new Error('no such project');
      },
      command: ['sh', '-c', 'echo READY; cat'],
    },
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  if (saved.host === undefined) delete process.env.METRO_HTTP_HOST;
  else process.env.METRO_HTTP_HOST = saved.host;
  if (saved.port === undefined) delete process.env.METRO_WEBHOOK_PORT;
  else process.env.METRO_WEBHOOK_PORT = saved.port;
  await new Promise<void>((r) => {
    server.close(() => {
      r();
    });
  });
});

const signed = async (method: string, path: string, who: string | typeof TEST_STRANGER = OWNER): Promise<Response> =>
  fetch(`${base}${path}`, { method, headers: { authorization: await auth(method, path, who) } });

function collect(ws: WebSocket, until: (text: string) => boolean, ms = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => {
      reject(new Error(`terminal said only: ${JSON.stringify(text)}`));
    }, ms);
    ws.on('message', (data: Buffer) => {
      text += data.toString('utf8');
      if (until(text)) {
        clearTimeout(timer);
        resolve(text);
      }
    });
  });
}

describe('terminal tickets', () => {
  test('a ticket is single use and expires after thirty seconds', () => {
    const now = 1_700_000_000_000;
    const { ticket, expiresAt } = mintTerminalTicket('owner', now);
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt).toBe(now + 30_000);
    expect(takeTerminalTicket(ticket, now + 1_000)).toBe('owner');
    expect(takeTerminalTicket(ticket, now + 1_000)).toBeNull();
    const late = mintTerminalTicket('owner', now).ticket;
    expect(takeTerminalTicket(late, now + 31_000)).toBeNull();
    for (let i = 0; i < 25; i += 1) mintTerminalTicket('owner', now);
    expect(pendingTerminalTickets()).toBeLessThanOrEqual(20);
  });
});

describe('the terminal over http and a websocket', () => {
  test('the owner reads availability and mints a ticket; a stranger and a wrong method are refused', async () => {
    const status = await signed('GET', '/api/terminal');
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ session: 'metro', available: true, command: ['sh', '-c', 'echo READY; cat'] });
    expect((await fetch(`${base}/api/terminal`)).status).toBe(401);
    expect((await signed('GET', '/api/terminal', TEST_STRANGER)).status).toBe(401);
    expect((await signed('POST', '/api/terminal')).status).toBe(405);
    expect((await signed('GET', '/api/terminal/tickets')).status).toBe(405);
    const minted = await signed('POST', '/api/terminal/tickets');
    expect(minted.status).toBe(200);
    const body = (await minted.json()) as { ticket: string; path: string };
    expect(body.path).toBe(`/api/terminal/${body.ticket}`);
  });

  test('a ticket opens the command in a pty, keystrokes go in, output comes out, and the ticket is spent', async () => {
    const { path } = (await (await signed('POST', '/api/terminal/tickets')).json()) as { path: string };
    const ws = new WebSocket(`${base.replace('http', 'ws')}${path}`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const ready = collect(ws, (t) => t.includes('READY'));
    expect(await ready).toContain('READY');
    const echoed = collect(ws, (t) => t.includes('hello from the page'));
    ws.send(JSON.stringify({ cols: 100, rows: 30 }));
    ws.send(Buffer.from('hello from the page\n'));
    expect(await echoed).toContain('hello from the page');
    ws.close();
    const again = new WebSocket(`${base.replace('http', 'ws')}${path}`);
    const refused = await new Promise<number>((resolve) => {
      again.once('unexpected-response', (_req, res) => {
        resolve(res.statusCode ?? 0);
      });
      again.once('error', () => {
        resolve(0);
      });
    });
    expect(refused).toBe(401);
  });

  test('an upgrade anywhere else is a 404', async () => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/tail`);
    const status = await new Promise<number>((resolve) => {
      ws.once('unexpected-response', (_req, res) => {
        resolve(res.statusCode ?? 0);
      });
      ws.once('error', () => {
        resolve(0);
      });
    });
    expect(status).toBe(404);
  });
});
