import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { accounts, type Account } from '../src/accounts.ts';
import { updateChannelMeta } from '../src/actions-meta.ts';
import { buildGroupInfo, type EthId } from '../src/conv-helpers.ts';

const alice = '0x' + 'a'.repeat(40);
const bob = '0x' + 'b'.repeat(40);
const accountId = 'metadata-test';
const line = `metro://xmtp/${accountId}/group1`;
let restoreOutput = () => {};

beforeEach(() => {
  const output = spyOn(process.stdout, 'write').mockReturnValue(true);
  restoreOutput = () => output.mockRestore();
});
afterEach(() => {
  restoreOutput();
  accounts.delete(accountId);
});

function fixture(raw = JSON.stringify({ v: 1, assigned: [bob], labels: ['Blocked'], custom: true })) {
  const state = {
    raw, names: [] as string[], writes: [] as string[], lookups: [] as EthId[], syncs: 0,
    syncFailure: false, readFailure: false, lookupFailure: false, membersFailure: false,
    beforeLookup: async () => {}, beforeWrite: async () => {},
  };
  const group = {
    id: 'group1', name: 'feat: existing',
    get appData() {
      if (state.readFailure) throw new Error('metadata read failed');
      return state.raw;
    },
    sync: async () => {
      state.syncs += 1;
      if (state.syncFailure) throw new Error('sync failed');
    },
    members: async () => {
      if (state.membersFailure) throw new Error('members failed');
      return [{ inboxId: 'alice-inbox' }, { inboxId: 'bob-inbox' }];
    },
    updateAppData: async (blob: string) => { await state.beforeWrite(); state.writes.push(blob); state.raw = blob; },
    updateName: async (name: string) => { state.names.push(name); group.name = name; },
  };
  const client = {
    conversations: { getConversationById: async () => group },
    fetchInboxIdByIdentifier: async (identifier: EthId) => {
      state.lookups.push(identifier);
      await state.beforeLookup();
      if (state.lookupFailure) throw new Error('identity lookup failed');
      return identifier.identifier === alice ? 'alice-inbox' : identifier.identifier === bob ? 'bob-inbox' : null;
    },
    preferences: { fetchInboxStates: async () => [
      { identifiers: [{ identifier: alice, identifierKind: 0 }] },
      { identifiers: [{ identifier: bob, identifierKind: 0 }] },
    ] },
  };
  const acct = { cfg: { id: accountId }, client } as unknown as Account;
  accounts.set(accountId, acct);
  return { state, group, acct };
}

function patch(appData: Record<string, unknown>, name?: string) {
  return updateChannelMeta('test', { line, appData, ...(name ? { name } : {}) });
}

describe('metadata action and independent mocked readback', () => {
  test('valid members normalize and preserve all other metadata', async () => {
    const initial = { v: 3, labels: ['Blocked'], assigned: [bob], github: 'https://github.com/a/b',
      preview: 'https://example.com', custom: { keep: true } };
    const { state, group, acct } = fixture(JSON.stringify(initial));
    await patch({ assigned: [bob, alice.toUpperCase().replace('0X', '0x'), alice] });
    expect(state.lookups.map((id) => id.identifier)).toEqual([bob, alice]);
    expect(state.writes).toHaveLength(1);
    expect(state.names).toHaveLength(0);
    const info = await buildGroupInfo(line, acct, group as unknown as Parameters<typeof buildGroupInfo>[2]);
    expect(info.assigned).toEqual([bob, alice]);
    expect(info.appData).toEqual({ ...initial, assigned: [bob, alice] });
    expect(info.rawAppData).toBe(state.raw);
    expect(info.name).toBe('feat: existing');
    expect(state.syncs).toBe(2);
  });

  test('combined patch and explicit clearing use the existing updater', async () => {
    const { state, group } = fixture();
    await patch({ assigned: [alice], labels: ['In review'], custom: { active: true } }, 'feat: renamed');
    expect(JSON.parse(state.raw)).toEqual({ v: 1, assigned: [alice], labels: ['In review'], custom: { active: true } });
    expect(group.name).toBe('feat: renamed');
    await patch({ assigned: [] });
    expect(JSON.parse(state.raw).assigned).toEqual([]);
  });

  test('oversized merged metadata and invalid names refuse all writes', async () => {
    const { state } = fixture();
    await expect(patch({ custom: 'x'.repeat(8192) }, 'feat: must not rename')).rejects.toThrow('8192 bytes');
    await expect(updateChannelMeta('test', { line, name: 42, appData: { assigned: [] } })).rejects.toThrow('name must be a string');
    expect(state.names).toHaveLength(0);
    expect(state.writes).toHaveLength(0);
  });

  test('nonmembers and invalid identifiers cannot partially rename the channel', async () => {
    const { state } = fixture();
    for (const assigned of [['0x' + 'c'.repeat(40)], ['worker-id']]) {
      await expect(patch({ assigned }, 'feat: must not rename')).rejects.toThrow();
    }
    expect(state.names).toHaveLength(0);
    expect(state.writes).toHaveLength(0);
  });

  test.each(['syncFailure', 'readFailure', 'lookupFailure', 'membersFailure'] as const)(
    'failed current state refuses all writes: %s', async (failure) => {
      const { state } = fixture();
      state[failure] = true;
      await expect(patch({ assigned: [alice] }, 'feat: must not rename')).rejects.toThrow();
      expect(state.names).toHaveLength(0);
      expect(state.writes).toHaveLength(0);
    },
  );

  test.each(['{broken', '[]', '{"assigned":[42]}'])(
    'invalid stored metadata cannot be erased: %s', async (raw) => {
      const { state } = fixture(raw);
      await expect(patch({ assigned: [alice] }, 'feat: must not rename')).rejects.toThrow();
      expect(state.names).toHaveLength(0);
      expect(state.writes).toHaveLength(0);
      expect(state.raw).toBe(raw);
    },
  );

  test('readback exposes exact malformed stored arrays instead of cleaning them', async () => {
    const { group, acct } = fixture('{"v":1,"assigned":["legacy",42]}');
    const info = await buildGroupInfo(line, acct, group as unknown as Parameters<typeof buildGroupInfo>[2]);
    expect(info.assigned).toEqual(['legacy', 42]);
    expect(info.appData).toEqual({ v: 1, assigned: ['legacy', 42] });
  });

  test('readback refuses failed sync or corrupt JSON', async () => {
    const { state, group, acct } = fixture();
    const read = () => buildGroupInfo(line, acct, group as unknown as Parameters<typeof buildGroupInfo>[2]);
    state.syncFailure = true;
    await expect(read()).rejects.toThrow('sync failed');
    state.syncFailure = false;
    state.raw = '{broken';
    await expect(read()).rejects.toThrow();
  });

  test('DM metadata is refused', async () => {
    const { state, acct } = fixture();
    acct.client.conversations.getConversationById = async () => ({ id: 'group1' }) as unknown as Awaited<ReturnType<typeof acct.client.conversations.getConversationById>>;
    await expect(patch({ assigned: [alice] })).rejects.toThrow('not a group');
    expect(state.writes).toHaveLength(0);
  });

  test('serializes local metadata edits and reads latest fields after lookup', async () => {
    const { state } = fixture();
    let release = () => {};
    const wait = new Promise<void>((resolve) => { release = resolve; });
    let started = () => {};
    const start = new Promise<void>((resolve) => { started = resolve; });
    state.beforeLookup = async () => { started(); await wait; };
    const first = patch({ assigned: [bob, alice] });
    await start;
    const second = patch({ labels: ['In review'] });
    state.raw = JSON.stringify({ ...JSON.parse(state.raw), external: true });
    release();
    await Promise.all([first, second]);
    expect(state.writes).toHaveLength(2);
    expect(JSON.parse(state.raw)).toEqual({ v: 1, assigned: [bob, alice], labels: ['In review'], custom: true, external: true });
  });

  test('canonical line aliases share the queue while a native write is pending', async () => {
    const { state } = fixture();
    let release = () => {};
    const wait = new Promise<void>((resolve) => { release = resolve; });
    let started = () => {};
    const start = new Promise<void>((resolve) => { started = resolve; });
    let writes = 0;
    state.beforeWrite = async () => { if (writes++ === 0) { started(); await wait; } };
    const first = patch({ assigned: [bob, alice] });
    await start;
    const second = updateChannelMeta('alias', { line: line + '/', appData: { labels: ['In review'] } });
    try {
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      expect(state.writes).toHaveLength(0);
    } finally { release(); }
    await Promise.all([first, second]);
    expect(state.writes).toHaveLength(2);
    expect(JSON.parse(state.raw)).toEqual({ v: 1, assigned: [bob, alice], labels: ['In review'], custom: true });
  });

  test('a rejected edit does not strand the next queued edit', async () => {
    const { state } = fixture();
    state.lookupFailure = true;
    const failed = expect(patch({ assigned: [alice] })).rejects.toThrow('identity lookup failed');
    const next = patch({ labels: ['In review'] });
    await Promise.all([failed, next]);
    expect(state.writes).toHaveLength(1);
    expect(JSON.parse(state.raw).assigned).toEqual([bob]);
  });
});
