import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleAgentUserRequest, type AgentUserApiDeps } from '../src/agent-user/api.ts';
import { auth } from './identity-helper.ts';

const OWNER = 'org_01AGENTUSERTEST0000';

let server: Server;
let base = '';
let restarts = 0;
let dir = '';
let host = { platform: 'linux', uid: 0 as number | undefined, cli: true };

const deps: AgentUserApiDeps = {
  restart: () => {
    restarts += 1;
  },
  agents: () => dir,
  host: () => host,
};

beforeAll(async () => {
  server = createServer((req, res) => {
    if (handleAgentUserRequest(req, res, deps)) return;
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
  dir = mkdtempSync(join(tmpdir(), 'metro-agent-user-api-'));
  restarts = 0;
  host = { platform: 'linux', uid: 0, cli: true };
});

const call = async (method: string, body?: unknown, role: 'admin' | 'member' = 'admin'): Promise<Response> =>
  fetch(`${base}/api/agent-user`, {
    method,
    headers: { authorization: await auth(OWNER, role), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const settled = (): Promise<void> => new Promise((r) => setTimeout(r, 800));

describe('switching Claude Code to its own user from the page', () => {
  test('an admin switches it on, the choice is saved and the daemon restarts; off removes it', async () => {
    expect(await (await call('GET')).json()).toMatchObject({ enabled: false, supported: true, reason: null });
    const on = await call('POST', { enabled: true });
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({ enabled: true, user: 'agent', restarting: true });
    expect(JSON.parse(readFileSync(join(dir, 'agent-user.json'), 'utf8'))).toEqual({ user: 'agent' });
    await settled();
    expect(restarts).toBe(1);
    expect(await (await call('POST', { enabled: false })).json()).toMatchObject({ enabled: false });
    expect(existsSync(join(dir, 'agent-user.json'))).toBe(false);
    await settled();
    expect(restarts).toBe(2);
  });

  test('a member reads it but cannot switch it', async () => {
    expect((await call('GET', undefined, 'member')).status).toBe(200);
    expect((await call('POST', { enabled: true }, 'member')).status).toBe(403);
    expect(existsSync(join(dir, 'agent-user.json'))).toBe(false);
  });

  test('refused by name where it cannot work, and a bad body is a 400', async () => {
    const cases: [Partial<typeof host>, string][] = [
      [{ platform: 'darwin' }, 'Linux only'],
      [{ uid: 501 }, 'normal user'],
      [{ cli: false }, 'metro serve'],
    ];
    for (const [over, words] of cases) {
      host = { ...{ platform: 'linux', uid: 0, cli: true }, ...over };
      const res = await call('POST', { enabled: true });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(words);
    }
    host = { platform: 'linux', uid: 0, cli: true };
    expect((await call('POST', { enabled: 'yes' })).status).toBe(400);
    await settled();
    expect(restarts).toBe(0);
  });
});

describe('moving work to the agent user', () => {
  test('refused until the agent user exists, and admin only', async () => {
    const get = async (role: 'admin' | 'member'): Promise<Response> =>
      fetch(`${base}/api/agent-user/workspace`, { headers: { authorization: await auth(OWNER, role) } });
    expect((await get('member')).status).toBe(403);
    const res = await get('admin');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('its own user first');
  });
});
