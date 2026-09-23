import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { bootDaemon, type Daemon } from './http-harness.ts';

let daemon: Daemon;
let base: string;

beforeAll(async () => {
  daemon = await bootDaemon();
    base = daemon.base;
});

afterAll(async () => {
  await daemon.close();
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
