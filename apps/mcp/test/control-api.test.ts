import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleControlRequest, type ControlApiDeps } from '../src/daemon/control-api.ts';
import { ApiError } from '../src/daemon/api-error.ts';
import { auth, type Who } from './identity-helper.ts';

const OWNER = '0xef8305e140ac520225daf050e2f71d5fbcc543e7';
const OTHER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';

let server: Server;
let base = '';
let stops = 0;
let restarts = 0;
let served = true;

const deps: ControlApiDeps = {
  authorize: (subject) => {
    if (subject !== OWNER) throw new ApiError('no such project', 404);
  },
  restart: () => {
    restarts += 1;
  },
  stop: () => {
    stops += 1;
  },
  served: () => served,
};

beforeAll(async () => {
  server = createServer((req, res) => {
    if (handleControlRequest(req, res, deps)) return;
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

beforeEach(() => {
  stops = 0;
  restarts = 0;
  served = true;
});

const call = async (method: string, path: string, who: Who | null): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: who === null ? {} : { authorization: await auth(method, path, who) },
  });

const settled = (): Promise<void> => new Promise((r) => setTimeout(r, 800));

describe('stopping and restarting the daemon from the page', () => {
  test('stop answers first and parks the daemon just after', async () => {
    const res = await call('POST', '/api/stop', OWNER);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopping: true });
    expect(stops).toBe(0);
    await settled();
    expect(stops).toBe(1);
    expect(restarts).toBe(0);
  });

  test('restart the same way', async () => {
    const res = await call('POST', '/api/restart', OWNER);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ restarting: true });
    await settled();
    expect(restarts).toBe(1);
    expect(stops).toBe(0);
  });

  test('only the owner, only signed, only POST', async () => {
    expect((await call('POST', '/api/stop', null)).status).toBe(401);
    expect((await call('POST', '/api/restart', OTHER)).status).toBe(404);
    expect((await call('GET', '/api/stop', OWNER)).status).toBe(405);
    expect((await call('OPTIONS', '/api/stop', null)).status).toBe(204);
    expect((await call('POST', '/api/stopping', OWNER)).status).toBe(404);
    await settled();
    expect(stops + restarts).toBe(0);
  });

  test('a daemon nobody would bring back refuses with 400', async () => {
    served = false;
    const res = await call('POST', '/api/stop', OWNER);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/not started by metro serve/);
    await settled();
    expect(stops).toBe(0);
  });
});
