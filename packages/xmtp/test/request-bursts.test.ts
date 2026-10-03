import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { IdentifierKind } from '@xmtp/node-sdk';
import { accounts, type Account } from '../src/accounts.ts';
import { handleCall } from '../src/actions.ts';
import { buildGroupInfo, buildMemberList } from '../src/conv-helpers.ts';
import { network } from '../src/network.ts';
import { TrainError } from '@metro-labs/core/train-error';

const accountId = 'request-bursts';
const line = `metro://xmtp/${accountId}/group`;
const address = '0x' + 'a'.repeat(40);
let writes: string[];
let restoreOutput = () => {};

beforeEach(() => {
  writes = [];
  const output = spyOn(process.stdout, 'write').mockImplementation((chunk) => { writes.push(String(chunk)); return true; });
  restoreOutput = () => output.mockRestore();
});
afterEach(() => { restoreOutput(); accounts.delete(accountId); });

function fixture() {
  const state = { syncs: 0, identities: 0, sends: 0, syncError: false };
  const group = {
    id: 'group', name: 'test', appData: '{"labels":["In review"]}',
    sync: async () => { state.syncs++; if (state.syncError) throw new Error('fresh sync failed'); },
    members: async () => [
      { inboxId: 'alice', permissionLevel: 1, accountIdentifiers: [{ identifierKind: IdentifierKind.Ethereum, identifier: address }] },
      { inboxId: 'non-ethereum', permissionLevel: 0, accountIdentifiers: [{ identifierKind: IdentifierKind.Passkey, identifier: 'passkey' }] },
    ],
    messages: async () => [],
    sendText: async () => { state.sends++; return 'sent'; },
  };
  const client = {
    conversations: { getConversationById: async () => ({ ...group }) },
    preferences: { fetchInboxStates: async () => { state.identities++; throw new Error('unexpected identity request'); } },
  };
  const acct = { cfg: { id: accountId }, client } as unknown as Account;
  accounts.set(accountId, acct);
  return { state, acct, group: group as unknown as Parameters<typeof buildGroupInfo>[2] };
}

function call(action: string, id = action) {
  return handleCall({ op: 'call', id, action, args: { line, text: 'test' } });
}

function responses(): Array<{ id: string; error?: string; result?: unknown }> {
  return writes.flatMap((chunk) => chunk.trim().split('\n')).map((raw) => JSON.parse(raw)).filter((row) => row.op === 'response');
}

describe('XMTP tool request bursts', () => {
  test('simultaneous read and group_info calls share a sync across SDK conversation wrappers', async () => {
    const { state } = fixture();
    await Promise.all(Array.from({ length: 29 }, (_, i) => call(i % 2 ? 'groupInfo' : 'read', `${i}`)));
    expect(state.syncs).toBe(1);
    expect(state.identities).toBe(0);
    expect(responses()).toHaveLength(29);
    expect(responses().every((row) => row.error === undefined)).toBe(true);
    await call('read');
    expect(state.syncs).toBe(2);
  });

  test('group metadata and members reuse identifiers from the SDK member list', async () => {
    const { state, acct, group } = fixture();
    const info = await buildGroupInfo(line, acct, group);
    expect(info.members).toEqual([
      { inboxId: 'alice', address }, { inboxId: 'non-ethereum', address: null },
    ]);
    expect(info.labels).toEqual(['In review']);
    const list = await buildMemberList(group);
    expect(list.members).toEqual([
      { id: 'alice', address, is_admin: true }, { id: 'non-ethereum', is_admin: false },
    ]);
    expect(state.identities).toBe(0);
  });

  test('read reports a failed fresh sync rather than silently returning stale success', async () => {
    const { state } = fixture();
    state.syncError = true;
    await call('read');
    expect(responses()).toEqual([{ op: 'response', id: 'read', error: 'fresh sync failed' }]);
  });

  test('the shared network cooldown rejects send before any SDK side effect', async () => {
    const { state } = fixture();
    const gate = spyOn(network, 'run').mockRejectedValue(new TrainError('xmtp_rate_limited', 'retry in 60s', { retryAfterMs: 60_000 }));
    try {
      await call('send');
      expect(state.sends).toBe(0);
      expect(responses()[0]?.error).toBe('retry in 60s');
      await call('accounts');
      expect(responses()[1]?.error).toBeUndefined();
    } finally { gate.mockRestore(); }
  });
});
