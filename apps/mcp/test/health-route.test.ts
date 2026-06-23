import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeEmit, startWebhookServer } from '../src/daemon/http.ts';

let server: Server;
let base: string;

beforeAll(async () => {
  process.env.METRO_WEBHOOK_PORT = String(20000 + Math.floor(Math.random() * 20000));
  process.env.METRO_HTTP_HOST = '127.0.0.1';
  server = await startWebhookServer(makeEmit());
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('/health route (Fly health check contract)', () => {
  test('/health returns 200 unauthenticated for the Fly health check', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = (await res.json()) as {
      status: string;
      version: string;
      uptime: number;
    };
    expect(body.status).toBe('ok');
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
    expect(typeof body.uptime).toBe('number');
  });
});
