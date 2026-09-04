import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleUpdateRequest, type UpdateApiDeps } from '../src/daemon/update-api.ts';
import { ApiError } from '../src/daemon/api-error.ts';
import { auth, type Who } from './identity-helper.ts';

const OWNER = '0xef8305e140ac520225daf050e2f71d5fbcc543e7';
const OTHER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';

let dir = '';
let bin = '';
let restarts = 0;
let server: Server;
let base = '';

function fakeCli(script: string): void {
  writeFileSync(bin, script);
}

const deps: UpdateApiDeps = {
  authorize: (subject) => {
    if (subject !== OWNER) throw new ApiError('no such project', 404);
  },
  restart: () => {
    restarts += 1;
  },
  cliBin: () => bin,
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metro-update-'));
  bin = join(dir, 'cli.mjs');
  server = createServer((req, res) => {
    if (handleUpdateRequest(req, res, deps)) return;
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
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  restarts = 0;
});

const session = (subject = OWNER): string => subject;
const call = async (method: string, token: Who | null): Promise<Response> =>
  fetch(`${base}/api/update`, { method, headers: token === null ? {} : { authorization: await auth(method, '/api/update', token) } });

describe('updating metro from the page', () => {
  test('the check reports the running, current and latest versions, and only the owner may ask', async () => {
    fakeCli(`process.stdout.write(JSON.stringify({ current: '0.1.0-beta.51', latest: '0.1.0-beta.52', newer: true }) + '\\n');`);
    const res = await call('GET', session());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ current: '0.1.0-beta.51', latest: '0.1.0-beta.52', newer: true });
    expect((await call('GET', session(OTHER))).status).toBe(404);
    expect((await call('GET', null)).status).toBe(401);
    expect((await call('DELETE', session())).status).toBe(405);
  });

  test('an update runs the CLI and asks the daemon to restart; nothing newer means no restart', async () => {
    fakeCli(`
      if (process.argv.includes('--check')) process.stdout.write(JSON.stringify({ current: '0.1.0-beta.51', latest: '0.1.0-beta.52', newer: true }) + '\\n');
      else process.stderr.write('metro is now 0.1.0-beta.52\\n');
    `);
    const res = await call('POST', session());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: true, version: '0.1.0-beta.52', restarting: true });
    await new Promise((r) => setTimeout(r, 700));
    expect(restarts).toBe(1);
  });

  test('a failing CLI is a 502 carrying its words, and no restart', async () => {
    fakeCli(`
      if (process.argv.includes('--check')) process.stdout.write(JSON.stringify({ current: '0.1.0-beta.51', latest: '0.1.0-beta.53', newer: true }) + '\\n');
      else { process.stderr.write('npm said no\\n'); process.exit(1); }
    `);
    const res = await call('POST', session());
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain('npm said no');
    await new Promise((r) => setTimeout(r, 700));
    expect(restarts).toBe(0);
  });

  test('without a CLI path the daemon says it cannot update itself', async () => {
    const res = await fetch(`${base}/api/update`, { headers: { authorization: await auth('GET', '/api/update', session()) } }).then(async (r) => {
      const local = createServer((req, out) => {
        if (handleUpdateRequest(req, out, { ...deps, cliBin: () => '' })) return;
        out.writeHead(404).end();
      });
      await new Promise<void>((done) => {
        local.listen(0, '127.0.0.1', done);
      });
      const port = (local.address() as AddressInfo).port;
      const answer = await fetch(`http://127.0.0.1:${String(port)}/api/update`, { headers: { authorization: await auth('GET', '/api/update', session()) } });
      local.close();
      return r.ok ? answer : answer;
    });
    expect(res.status).toBe(400);
  });
});
