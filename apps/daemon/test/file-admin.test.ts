import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  localAttachAccount,
  localCreateAgent,
  localDetachAccount,
  localImportAgent,
  localListAgents,
  localOwner,
  setLocalOwner,
  localSetAccountEnabled,
} from '../src/agents/file-admin.ts';
import { agentIdForKey, setKeyMap } from '../src/agents/keys.ts';
import { ApiError } from '@metro-labs/http/api-error';

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

const stored = (): { key: string; stations: { id: string; config: Record<string, unknown> }[] } =>
  JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8')) as never;

describe('who owns a local daemon', () => {
  test('the operator sets the owner, lowercased, 0600, and may change it', () => {
    expect(localOwner(dir)).toBe(OWNER);
    expect((statSync(join(dir, '.owner')).mode & 0o777).toString(8)).toBe('600');
    expect(() => setLocalOwner('nope', dir)).toThrow(/nor an Ethereum address/);
    expect(setLocalOwner(OTHER, dir)).toBe(OTHER);
    expect(localOwner(dir)).toBe(OTHER);
    setLocalOwner(OWNER, dir);
  });

});

describe('agents kept as files', () => {
  test('creating one writes a 0600 file with a fresh key that authenticates at once', async () => {
    const made = await localCreateAgent('suzy', dir);
    expect(made.key).toMatch(/^mk_[A-Za-z0-9_-]{43}$/);
    const path = join(dir, 'agent.json');
    expect((statSync(path).mode & 0o777).toString(8)).toBe('600');
    expect(stored()).toEqual({ version: 1, id: made.id, name: 'suzy', key: made.key, stations: [] });
    expect(agentIdForKey(made.key)).toBe(made.id);
    expect(await localListAgents(dir)).toEqual([
      { id: made.id, name: 'suzy' },
    ]);
  });

  test('a bad name or a second agent are refused', async () => {
    await localCreateAgent('suzy', dir);
    expect(await status(localCreateAgent('has space', dir))).toBe(400);
    expect(await status(localCreateAgent('tony', dir))).toBe(409);
  });

  test('a station lands in the file with a fresh id; the same bot token cannot land twice', async () => {
    const suzy = await localCreateAgent('suzy', dir);
    const ref = await localAttachAccount(suzy.id, 'telegram-bot', { token: 'tok' }, dir);
    expect(ref.accountId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{10}$/);
    expect(stored().stations).toEqual([
      { station: 'telegram-bot', id: ref.accountId, allowlist: ['*'], enabled: true, config: { token: 'tok' } },
    ]);
    expect(await localSetAccountEnabled(suzy.id, 'telegram-bot', ref.accountId, false, dir)).toBe(false);
    expect(stored().stations[0]).toMatchObject({ id: ref.accountId, enabled: false, config: { token: 'tok' } });
    expect(await localSetAccountEnabled(suzy.id, 'telegram-bot', ref.accountId, true, dir)).toBe(true);
    expect(stored().stations[0]).toMatchObject({ enabled: true });
    expect(await status(localSetAccountEnabled(suzy.id, 'telegram-bot', 'acct9999999', false, dir))).toBe(404);
    expect(await status(localAttachAccount(suzy.id, 'telegram-bot', { token: 'tok' }, dir))).toBe(409);
    expect(await status(localAttachAccount(suzy.id, 'webhook', {}, dir))).toBe(400);
    expect(await status(localAttachAccount('agent009999', 'telegram-bot', { token: 'x' }, dir))).toBe(404);
  });

  test('a detach removes the station and keeps the agent and its key', async () => {
    const suzy = await localCreateAgent('suzy', dir);
    const ref = await localAttachAccount(suzy.id, 'xmtp', { privateKey: '0x1' }, dir);
    expect(await status(localDetachAccount(suzy.id, 'xmtp', 'nope0000001', dir))).toBe(404);
    await localDetachAccount(suzy.id, 'xmtp', ref.accountId, dir);
    expect(stored().stations).toEqual([]);
    expect(agentIdForKey(suzy.key)).toBe(suzy.id);
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

  test('keeps id, key and station ids, and registers the key', async () => {
    const made = await localImportAgent(loaded(), dir);
    expect(made).toEqual({ id: 'agentTony01', name: 'Tony', key: TONY_KEY, stations: 2 });
    expect(stored()).toMatchObject({
      key: TONY_KEY,
      stations: [
        { station: 'telegram-bot', id: 'stn00000001', allowlist: ['*'], config: { token: 't' } },
        { station: 'xmtp', id: 'stn00000002', allowlist: ['x'], config: { privateKey: '0x1' } },
      ],
    });
    expect(agentIdForKey(TONY_KEY)).toBe('agentTony01');
    expect((await localListAgents(dir)).map((a) => a.id)).toEqual(['agentTony01']);
  });

  test("metro.box's older 64-character keys import as they are", async () => {
    const old = 'a1b2c3d4'.repeat(8);
    const made = await localImportAgent(loaded({ key: old, name: 'Old' }), dir);
    expect(made.key).toBe(old);
    expect(agentIdForKey(old)).toBe('agentTony01');
  });

  test('importing the same agent again refreshes it in place and keeps what was attached here', async () => {
    await localImportAgent(loaded(), dir);
    await localAttachAccount('agentTony01', 'discord-bot', { token: 'd' }, dir);
    const again = await localImportAgent(
      loaded({ accounts: [{ station: 'telegram-bot', id: 'stn00000001', allowlist: null, config: { token: 't2' } }] }),
      dir,
    );
    expect(again.stations).toBe(3);
    const file = stored();
    expect(file.stations.map((s) => s.config)).toEqual([{ token: 't2' }, { privateKey: '0x1' }, { token: 'd' }]);
    expect(agentIdForKey(TONY_KEY)).toBe('agentTony01');
  });

  test('importing into the agent already here keeps its key, whatever key the import carries', async () => {
    await localImportAgent(loaded(), dir);
    const other = `mk_${'d'.repeat(43)}`;
    expect((await localImportAgent(loaded({ key: other }), dir)).key).toBe(TONY_KEY);
    expect(stored().key).toBe(TONY_KEY);
    expect(agentIdForKey(other)).toBeUndefined();
  });

  test('a shape the file cannot hold is a 400 naming the field, not a bare 500', async () => {
    const bad = localImportAgent(loaded({ name: 'Bad', id: 'agentTony09', key: 'mk_nope' }), dir);
    await expect(bad).rejects.toThrow(/not an agent key/);
    expect(await status(localImportAgent(loaded({ name: 'Bad', id: 'agentTony09', key: 'mk_nope' }), dir))).toBe(400);
  });

  test('a webhook station and every clash are refused', async () => {
    expect(await status(localImportAgent(loaded({ accounts: [{ station: 'webhook', id: 'stn00000003', allowlist: null, config: {} }] }), dir))).toBe(400);
    await localImportAgent(loaded(), dir);
    expect(await status(localImportAgent(loaded({ name: 'tony2' }), dir))).toBe(0);
    expect(stored().stations).toHaveLength(2);
    expect(await status(localImportAgent(loaded({ name: 'tony3', id: 'agentTony02' }), dir))).toBe(409);
    expect(await status(localImportAgent(loaded({ name: 'suzy', id: 'agentTony03', key: `mk_${'c'.repeat(43)}` }), dir))).toBe(409);
    expect(agentIdForKey(TONY_KEY)).toBe('agentTony01');
  });
});

describe('one agent per box, at a fixed place', () => {
  test('the daemon creates the agent itself once the owner is known, and never a second one', async () => {
    const { ensureLocalAgent } = await import('../src/agents/file-admin.ts');
    expect(await ensureLocalAgent(dir)).toBe('created');
    expect(existsSync(join(dir, 'agent.json'))).toBe(true);
    const file = JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8')) as { id: string; name: string | null; key: string };
    expect(file.name).toBeNull();
    expect(file.key.startsWith('mk_')).toBe(true);
    expect(await ensureLocalAgent(dir)).toBe('present');
    expect(await status(localCreateAgent('second', dir))).toBe(409);
  });

  test('an agent file from the folder-per-agent days is moved to the fixed place at boot, id and key kept', async () => {
    const { migrateAgentLayout } = await import('../src/agents/files.ts');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    expect(migrateAgentLayout(dir)).toBe('none');
    mkdirSync(join(dir, 'Tony'));
    const legacy = { version: 1, id: 'agentTony01', name: 'Tony', key: 'mk_' + 'a'.repeat(40), owner: OWNER, stations: [], connectors: [] };
    writeFileSync(join(dir, 'Tony', 'agent.json'), JSON.stringify(legacy));
    expect(migrateAgentLayout(dir)).toBe('moved');
    expect(existsSync(join(dir, 'Tony'))).toBe(false);
    const moved = JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8')) as { id: string; key: string; name: string };
    expect(moved).toMatchObject({ id: 'agentTony01', key: legacy.key, name: 'Tony' });
    expect(migrateAgentLayout(dir)).toBe('kept');
  });
});
