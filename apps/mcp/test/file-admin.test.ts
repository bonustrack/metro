import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LOCAL_PROJECT_ID,
  localAttachAccount,
  localCreateAgent,
  localDeleteAgent,
  localDetachAccount,
  localImportAgent,
  localListAgents,
  localOwner,
  localResetAgentKey,
  ownerSignIn,
  setLocalOwner,
} from '../src/db/file-admin.ts';
import { agentIdForKey, setKeyMap } from '../src/db/key-map.ts';
import { ApiError } from '../src/daemon/api-error.ts';

const OWNER = '0xef8305e140ac520225daf050e2f71d5fbcc543e7';
const OTHER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
let dir = '';

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metro-admin-'));
  setKeyMap([]);
  setLocalOwner(OWNER.toUpperCase().replace('0X', '0x'), dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const status = async (work: Promise<unknown>): Promise<number> =>
  work.then(
    () => 0,
    (err: unknown) => (err instanceof ApiError ? err.status : -1),
  );

const stored = (name: string): { key: string; owner: string; stations: { id: string; config: Record<string, unknown> }[] } =>
  JSON.parse(readFileSync(join(dir, name, 'agent.json'), 'utf8')) as never;

describe('who owns a local daemon', () => {
  test('the operator sets the owner, lowercased, 0600, and may change it', () => {
    expect(localOwner(dir)).toBe(OWNER);
    expect((statSync(join(dir, '.owner')).mode & 0o777).toString(8)).toBe('600');
    expect(() => setLocalOwner('nope', dir)).toThrow(/not an Ethereum address/);
    expect(setLocalOwner(OTHER, dir)).toBe(OTHER);
    expect(localOwner(dir)).toBe(OTHER);
    setLocalOwner(OWNER, dir);
  });

  test('sign-in never claims: only the set owner passes, and nobody does on a machine without one', async () => {
    expect(await ownerSignIn(OWNER.toUpperCase().replace('0X', '0x'), dir)).toBe(OWNER);
    expect(await status(ownerSignIn(OTHER, dir))).toBe(403);
    const fresh = mkdtempSync(join(tmpdir(), 'metro-fresh-'));
    expect(await status(ownerSignIn(OWNER, fresh))).toBe(403);
    expect(localOwner(fresh)).toBeNull();
    rmSync(fresh, { recursive: true, force: true });
  });
});

describe('agents kept as files', () => {
  test('creating one writes a 0600 file with a fresh key that authenticates at once', async () => {
    const made = await localCreateAgent(OWNER, LOCAL_PROJECT_ID, 'suzy', dir);
    expect(made.key).toMatch(/^mk_[A-Za-z0-9_-]{43}$/);
    const path = join(dir, 'suzy', 'agent.json');
    expect((statSync(path).mode & 0o777).toString(8)).toBe('600');
    expect(stored('suzy')).toMatchObject({ key: made.key, owner: OWNER, stations: [] });
    expect(agentIdForKey(made.key)).toBe(made.id);
    expect(await localListAgents(OWNER, LOCAL_PROJECT_ID, dir)).toEqual([
      { id: made.id, name: 'suzy', owned: true, key: made.key },
    ]);
  });

  test('another wallet, another project, a bad or duplicate name are refused', async () => {
    await localCreateAgent(OWNER, LOCAL_PROJECT_ID, 'suzy', dir);
    expect(await status(localCreateAgent(OTHER, LOCAL_PROJECT_ID, 'x1', dir))).toBe(404);
    expect(await status(localCreateAgent(OWNER, 'prj00000001', 'x1', dir))).toBe(404);
    expect(await status(localCreateAgent(OWNER, LOCAL_PROJECT_ID, 'has space', dir))).toBe(400);
    expect(await status(localCreateAgent(OWNER, LOCAL_PROJECT_ID, 'suzy', dir))).toBe(409);
    expect(await status(localListAgents(OTHER, LOCAL_PROJECT_ID, dir))).toBe(404);
  });

  test('a station lands in the file with a fresh id; the same bot token cannot land twice', async () => {
    const suzy = await localCreateAgent(OWNER, LOCAL_PROJECT_ID, 'suzy', dir);
    const tony = await localCreateAgent(OWNER, LOCAL_PROJECT_ID, 'tony', dir);
    const ref = await localAttachAccount(OWNER, suzy.id, 'telegram-bot', { token: 'tok' }, dir);
    expect(ref.accountId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{10}$/);
    expect(stored('suzy').stations).toEqual([
      { station: 'telegram-bot', id: ref.accountId, allowlist: ['*'], config: { token: 'tok' } },
    ]);
    expect(await status(localAttachAccount(OWNER, tony.id, 'telegram-bot', { token: 'tok' }, dir))).toBe(409);
    expect(await status(localAttachAccount(OWNER, tony.id, 'webhook', {}, dir))).toBe(400);
    expect(await status(localAttachAccount(OTHER, suzy.id, 'telegram-bot', { token: 'x' }, dir))).toBe(404);
  });

  test('detach, key reset and delete, in the order a person would do them', async () => {
    const suzy = await localCreateAgent(OWNER, LOCAL_PROJECT_ID, 'suzy', dir);
    const ref = await localAttachAccount(OWNER, suzy.id, 'xmtp', { privateKey: '0x1' }, dir);
    expect(await status(localDeleteAgent(OWNER, suzy.id, dir))).toBe(409);
    expect(await status(localDetachAccount(OWNER, suzy.id, 'xmtp', 'nope0000001', dir))).toBe(404);
    await localDetachAccount(OWNER, suzy.id, 'xmtp', ref.accountId, dir);
    expect(stored('suzy').stations).toEqual([]);
    const reset = await localResetAgentKey(OWNER, suzy.id, dir);
    expect(reset.key).not.toBe(suzy.key);
    expect(stored('suzy').key).toBe(reset.key);
    expect(agentIdForKey(reset.key)).toBe(suzy.id);
    expect(agentIdForKey(suzy.key)).toBeUndefined();
    expect(await localDeleteAgent(OWNER, suzy.id, dir)).toEqual({ id: suzy.id, name: 'suzy' });
    expect(existsSync(join(dir, 'suzy'))).toBe(false);
    expect(agentIdForKey(reset.key)).toBeUndefined();
    expect(await status(localDeleteAgent(OWNER, suzy.id, dir))).toBe(404);
  });
});

describe('importing an agent from metro.box', () => {
  const TONY_KEY = `mk_${'b'.repeat(43)}`;
  const loaded = (over: Record<string, unknown> = {}) => ({
    id: 'agentTony01',
    name: 'Tony',
    key: TONY_KEY,
    accounts: [
      { station: 'telegram-bot' as const, id: 'stn00000001', allowlist: null, config: { token: 't' } },
      { station: 'xmtp' as const, id: 'stn00000002', allowlist: ['x'], config: { privateKey: '0x1' } },
    ],
    ...over,
  });

  test('keeps id, key and station ids, registers the key, and the owner is this machine', async () => {
    const made = await localImportAgent(OWNER, loaded(), dir);
    expect(made).toEqual({ id: 'agentTony01', name: 'Tony', key: TONY_KEY, stations: 2 });
    expect(stored('Tony')).toMatchObject({
      key: TONY_KEY,
      owner: OWNER,
      stations: [
        { station: 'telegram-bot', id: 'stn00000001', allowlist: ['*'], config: { token: 't' } },
        { station: 'xmtp', id: 'stn00000002', allowlist: ['x'], config: { privateKey: '0x1' } },
      ],
    });
    expect(agentIdForKey(TONY_KEY)).toBe('agentTony01');
    expect((await localListAgents(OWNER, LOCAL_PROJECT_ID, dir)).map((a) => a.id)).toEqual(['agentTony01']);
  });

  test("metro.box's older 64-character keys import as they are", async () => {
    const old = 'a1b2c3d4'.repeat(8);
    const made = await localImportAgent(OWNER, loaded({ key: old, name: 'Old' }), dir);
    expect(made.key).toBe(old);
    expect(agentIdForKey(old)).toBe('agentTony01');
  });

  test('importing the same agent again refreshes it in place and keeps what was attached here', async () => {
    await localImportAgent(OWNER, loaded(), dir);
    await localAttachAccount(OWNER, 'agentTony01', 'discord-bot', { token: 'd' }, dir);
    const again = await localImportAgent(
      OWNER,
      loaded({ accounts: [{ station: 'telegram-bot', id: 'stn00000001', allowlist: null, config: { token: 't2' } }] }),
      dir,
    );
    expect(again.stations).toBe(3);
    const file = stored('Tony');
    expect(file.stations.map((s) => s.config)).toEqual([{ token: 't2' }, { privateKey: '0x1' }, { token: 'd' }]);
    expect(agentIdForKey(TONY_KEY)).toBe('agentTony01');
  });

  test('a shape the file cannot hold is a 400 naming the field, not a bare 500', async () => {
    const bad = localImportAgent(OWNER, loaded({ name: 'Bad', id: 'agentTony09', key: 'mk_nope' }), dir);
    await expect(bad).rejects.toThrow(/not an agent key/);
    expect(await status(localImportAgent(OWNER, loaded({ name: 'Bad', id: 'agentTony09', key: 'mk_nope' }), dir))).toBe(400);
  });

  test('a stranger, a webhook station, a keyless agent and every clash are refused', async () => {
    expect(await status(localImportAgent(OTHER, loaded(), dir))).toBe(404);
    expect(await status(localImportAgent(OWNER, loaded({ accounts: [{ station: 'webhook', id: 'stn00000003', allowlist: null, config: {} }] }), dir))).toBe(400);
    expect(await status(localImportAgent(OWNER, loaded({ key: null }), dir))).toBe(400);
    await localImportAgent(OWNER, loaded(), dir);
    expect(await status(localImportAgent(OWNER, loaded({ name: 'tony2' }), dir))).toBe(0);
    expect(stored('Tony').stations).toHaveLength(2);
    expect(await status(localImportAgent(OWNER, loaded({ name: 'tony3', id: 'agentTony02' }), dir))).toBe(409);
    const suzy = await localCreateAgent(OWNER, LOCAL_PROJECT_ID, 'suzy', dir);
    expect(await status(localImportAgent(OWNER, loaded({ name: 'suzy', id: 'agentTony03', key: `mk_${'c'.repeat(43)}` }), dir))).toBe(409);
    expect(agentIdForKey(suzy.key)).toBe(suzy.id);
  });
});
