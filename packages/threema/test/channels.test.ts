import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DIRECTORY_LIMIT } from '@metro-labs/core/stations/channel-directory';
import { accounts, bootAccount } from '../src/accounts.ts';
import { listChannels } from '../src/channels.ts';
import { chatFiles, DirectStore } from '../src/chats.ts';
import { groupFiles } from '../src/groups.ts';
import { threemaStation } from '../src/station.ts';

const GROUP = { creator: 'ALICE001', groupId: 'aabbccdd00112233' };
const config = (id: string) => ({ id, gatewayId: '*METRO01', secret: 'fixture-only', privateKey: '11'.repeat(32) });

function account(id: string) {
  const acct = bootAccount(config(id));
  accounts.set(id, acct);
  return acct;
}

function seed(id: string): void {
  const acct = account(id);
  acct.groups.setup(GROUP.creator, GROUP.groupId, ['*METRO01', 'BOB00002']);
  acct.groups.rename(GROUP.creator, GROUP.groupId, 'Quiet group');
  acct.chats.note('bob00002', 'Bob');
}

describe('Threema channel discovery', () => {
  let dir: string;
  let previousDir: string | undefined;

  beforeEach(() => {
    previousDir = process.env.THREEMA_GROUPS_DIR;
    dir = mkdtempSync(join(tmpdir(), 'threema-directory-'));
    process.env.THREEMA_GROUPS_DIR = dir;
    accounts.clear();
  });

  afterEach(() => {
    accounts.clear();
    if (previousDir === undefined) delete process.env.THREEMA_GROUPS_DIR;
    else process.env.THREEMA_GROUPS_DIR = previousDir;
    rmSync(dir, { recursive: true, force: true });
  });

  test('lists stored groups without messages and observed directs, not public-key contacts', async () => {
    seed('one');
    account('two').chats.note('CAROL003', 'Carol');
    accounts.get('one')?.publicKeys.set('CONTACT1', new Uint8Array(32));
    const fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('discovery must stay local'));
    const stdout = spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      const result = await listChannels({ account: 'one' });
      expect(result.channels).toEqual([
        { id: 'ALICE001-aabbccdd00112233', line: 'metro://threema/one/ALICE001-aabbccdd00112233', name: 'Quiet group', kind: 'group' },
        { id: 'BOB00002', line: 'metro://threema/one/BOB00002', name: 'Bob', kind: 'direct' },
      ]);
      expect(result.capability).toMatchObject({ supported: true, complete: false, source: 'local' });
      expect(result.capability.reason).toContain('no remote conversation-list or history endpoint');
      expect(threemaStation.discoversChannels).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  test('requires an explicit known account, even with one account and a line', async () => {
    account('one');
    for (const args of [{}, { line: 'metro://threema/one/ALICE001' }, { account: '' }, { account: ' ' }, { account: 1 }])
      expect(() => listChannels(args)).toThrow('requires an explicit Threema account');
    expect(() => listChannels({ account: 'missing' })).toThrow('unknown account');
    expect(await listChannels({ account: 'one' })).toMatchObject({
      channels: [], capability: { supported: true, complete: false, source: 'local' },
    });
  });

  test('delegates search and snapshot paging to core with account-isolated cursors', async () => {
    seed('one');
    account('two').chats.note('CAROL003', 'Carol');
    expect((await listChannels({ account: 'one', query: 'qUiEt' })).channels).toHaveLength(1);
    expect((await listChannels({ account: 'one', query: 'carol' })).channels).toHaveLength(0);
    const first = await listChannels({ account: 'one', limit: 1 });
    expect(first.channels[0]?.kind).toBe('group');
    expect(first.next_cursor).toBeString();
    expect((await listChannels({ account: 'one', cursor: first.next_cursor })).channels).toEqual([
      { id: 'BOB00002', line: 'metro://threema/one/BOB00002', name: 'Bob', kind: 'direct' },
    ]);
    await expect(listChannels({ account: 'two', cursor: first.next_cursor })).rejects.toThrow('cursor');
    accounts.set('one', bootAccount(config('one')));
    await expect(listChannels({ account: 'one', cursor: first.next_cursor })).rejects.toThrow('cursor');
  });

  test('retains names on restart and removes a self-left group from fresh listings and disk', async () => {
    seed('one');
    const restarted = account('one');
    expect((await listChannels({ account: 'one' })).channels).toHaveLength(2);
    restarted.groups.leave(GROUP, 'BOB00002');
    expect((await listChannels({ account: 'one' })).channels).toHaveLength(2);
    restarted.groups.leave(GROUP, '*METRO01');
    account('one');
    expect((await listChannels({ account: 'one' })).channels).toEqual([
      { id: 'BOB00002', line: 'metro://threema/one/BOB00002', name: 'Bob', kind: 'direct' },
    ]);
    expect(readFileSync(groupFiles.path('one'), 'utf8')).toBe('[]');
  });

  test('forgets both metadata stores only for removed accounts', async () => {
    seed('one');
    seed('two');
    seed('three');
    const unrelated = join(dir, 'unrelated.json');
    writeFileSync(unrelated, '{}');
    await threemaStation.forget?.('one');
    for (const files of [groupFiles, chatFiles]) {
      expect(existsSync(files.path('one'))).toBe(false);
      expect(existsSync(files.path('two'))).toBe(true);
    }
    await threemaStation.forgetExcept?.(['two']);
    for (const files of [groupFiles, chatFiles]) {
      expect(existsSync(files.path('three'))).toBe(false);
      expect(existsSync(files.path('two'))).toBe(true);
    }
    expect(existsSync(unrelated)).toBe(true);
    expect(account('one').chats.list()).toEqual([]);
    expect(account('one').groups.list()).toEqual([]);
  });

  test('persists only canonical IDs and bounded nicknames in a private file', () => {
    const store = new DirectStore('one');
    store.note(' alice001 ', 'Alice');
    store.note('ALICE001');
    store.note('ALICE001', '  ');
    store.note('BOB00002', 'B'.repeat(300));
    store.note('bad/id', 'invalid');
    const expected = [{ id: 'ALICE001', name: 'Alice' }, { id: 'BOB00002', name: 'B'.repeat(256) }];
    expect(store.list()).toEqual(expected);
    const path = chatFiles.path('one');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(expected);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(new DirectStore('one').list()).toEqual(expected);
    expect(new DirectStore('two').list()).toEqual([]);
  });

  test('projects stored data and caps loaded and newly observed direct metadata', () => {
    const entries = Array.from({ length: DIRECTORY_LIMIT + 2 }, (_, i) => ({
      id: String(i).padStart(8, '0'), name: 'Fixture', text: 'private body', messageId: '0011223344556677', media: { key: 'private key' },
    }));
    writeFileSync(chatFiles.path('one'), JSON.stringify(entries));
    const store = new DirectStore('one');
    expect(store.list()).toHaveLength(DIRECTORY_LIMIT);
    expect(store.list()[0]?.id).toBe('00000002');
    store.note('NEWCHAT1', 'New chat');
    expect(store.list()).toHaveLength(DIRECTORY_LIMIT);
    expect(store.list()[0]?.id).toBe('00000003');
    const persisted = readFileSync(chatFiles.path('one'), 'utf8');
    for (const value of ['text', 'messageId', 'media', 'private body', 'private key'])
      expect(persisted).not.toContain(value);
    expect(new DirectStore('one').list()).toEqual(store.list());
  });

  test('a metadata save failure keeps discovery in memory without failing observations', () => {
    const store = new DirectStore('one');
    mkdirSync(chatFiles.path('one'));
    expect(() => store.note('ALICE001', 'Alice')).not.toThrow();
    expect(store.list()).toEqual([{ id: 'ALICE001', name: 'Alice' }]);
  });
});
