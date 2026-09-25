import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleSchedulesRequest } from '../src/agent-user/schedules-api.ts';
import { auth } from './identity-helper.ts';

const OWNER = 'org_01SCHEDULESTEST00000';
let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    if (handleSchedulesRequest(req, res)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => {
    server.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((r) => {
    server.close(() => {
      r();
    });
  });
});

const call = async (method: string, role: 'admin' | 'member', body?: unknown): Promise<Response> =>
  fetch(`${base}/api/schedules`, {
    method,
    headers: { authorization: await auth(OWNER, role), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('the scheduled jobs of a box', () => {
  test('admin only; a retry names a job, and needs the agent user', async () => {
    expect((await call('GET', 'member')).status).toBe(403);
    const listed = await call('GET', 'admin');
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ jobs: expect.any(Array) as unknown as unknown[] });
    expect((await call('POST', 'admin', {})).status).toBe(400);
    expect((await call('POST', 'admin', { id: 'cron-root:nope' })).status).toBe(409);
  });
});
