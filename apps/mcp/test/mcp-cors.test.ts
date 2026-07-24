import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeEmit, startWebhookServer } from '../src/daemon/http.ts';

let server: Server;
let base: string;

beforeAll(async () => {
  process.env.METRO_WEBHOOK_PORT = String(
    20000 + Math.floor(Math.random() * 20000),
  );
  process.env.METRO_HTTP_HOST = '127.0.0.1';
  server = await startWebhookServer(makeEmit(), async (_req, res) => {
    res.writeHead(200).end('ok');
  });
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('MCP CORS (browser cross-origin from the accounts UI)', () => {
  test('preflight from metro.box returns 204 with CORS headers', async () => {
    const res = await fetch(`${base}/`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://metro.box',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,mcp-session-id',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'https://metro.box',
    );
    const allow = res.headers.get('access-control-allow-headers') ?? '';
    expect(allow.toLowerCase()).toContain('content-type');
    expect(allow.toLowerCase()).toContain('mcp-session-id');
    expect(
      (res.headers.get('access-control-expose-headers') ?? '').toLowerCase(),
    ).toContain('mcp-session-id');
    await res.text();
  });

  test('POST from metro.box reaches the handler with CORS header', async () => {
    const res = await fetch(`${base}/`, {
      method: 'POST',
      headers: { origin: 'https://metro.box', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'https://metro.box',
    );
    await res.text();
  });

  test('a disallowed origin gets no CORS header', async () => {
    const res = await fetch(`${base}/`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'POST',
      },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    await res.text();
  });

  test('a localhost dev origin is reflected', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5175',
        'access-control-request-method': 'POST',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'http://localhost:5175',
    );
    await res.text();
  });
});
