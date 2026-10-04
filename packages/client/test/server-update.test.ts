import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { duringUpdate, noteUpdate, probeServer, type ServerStatus } from '../src/api/servers.js';
import { runUpdate } from '../src/api/update.js';
import { setCurrentServer } from '../src/auth/daemon.js';
import { clearAccount } from '../src/auth/account.js';
import { configurePlatform, memoryKeyValue } from '../src/platform.js';
import { installTestAccount } from './account-fixture.js';

const HOST = 'metro-abc123.tail1234.ts.net';
const BASE = `https://${HOST}`;
const MINUTE = 60_000;
const realFetch = globalThis.fetch;
const offline: ServerStatus = { state: 'offline', version: null, owner: null };
const live = (version: string): ServerStatus => ({ state: 'live', version, owner: null });

function serve(answers: unknown[]): void {
  globalThis.fetch = ((url: string) => {
    const next = answers.shift() ?? null;
    if (next === null) return Promise.reject(new TypeError(`${url} did not answer`));
    return Promise.resolve(new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } }));
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  configurePlatform({ kv: memoryKeyValue() });
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setCurrentServer(null);
  clearAccount();
});

describe('an agent restarting after an update', () => {
  test('reads as updating while it does not answer, until it answers on the new version', () => {
    noteUpdate(BASE, 'v2', 0);
    expect(duringUpdate(BASE, live('v1'), MINUTE / 2)).toEqual(live('v1'));
    expect(duringUpdate(BASE, offline, MINUTE).state).toBe('updating');
    expect(duringUpdate('https://other.tail1234.ts.net', offline, MINUTE).state).toBe('offline');
    expect(duringUpdate(BASE, live('v2'), 2 * MINUTE)).toEqual(live('v2'));
    expect(duringUpdate(BASE, offline, 3 * MINUTE).state).toBe('offline');
  });

  test('after ten minutes without an answer it reads as offline again', () => {
    noteUpdate(BASE, 'v2', 0);
    expect(duringUpdate(BASE, offline, 10 * MINUTE - 1).state).toBe('updating');
    expect(duringUpdate(BASE, offline, 10 * MINUTE).state).toBe('offline');
    expect(duringUpdate(BASE, offline, MINUTE).state).toBe('offline');
  });

  test('the Update call notes the restart for the probe of the same box, and only a restart does', async () => {
    installTestAccount();
    setCurrentServer({ id: 'agent000001', host: HOST });
    serve([{ updated: false, version: 'v1', restarting: false }, null]);
    await runUpdate();
    expect((await probeServer(HOST)).state).toBe('offline');
    serve([{ updated: true, version: 'v2', restarting: true }, null, { mode: 'local', owner: null, version: 'v2' }, null]);
    await runUpdate();
    expect((await probeServer(HOST)).state).toBe('updating');
    expect(await probeServer(HOST)).toEqual(live('v2'));
    expect((await probeServer(HOST)).state).toBe('offline');
  });
});
