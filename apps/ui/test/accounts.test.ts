import { describe, expect, test } from 'bun:test';
import {
  accountsForAgent,
  attributeUntagged,
  countAccounts,
  groupAccounts,
  unattributedAccounts,
} from '../src/api/accounts';

const PAYLOAD = {
  telegram: [
    { id: 'ada-tg', owner: 'ada', agentId: 1 },
    { id: 'bob-tg', owner: 'bob', agentId: 2 },
  ],
  discord: [{ id: 'ada-dc', token: 'mk_fake_never_shown', agentId: 1 }],
  line: [],
};

describe('groupAccounts carries the owning agent', () => {
  test('each row keeps the agent id and never renders it as a field', () => {
    const groups = groupAccounts(PAYLOAD);
    const telegram = groups.find((g) => g.station === 'telegram');
    expect(telegram?.rows.map((r) => r.agentId)).toEqual([1, 2]);
    expect(telegram?.rows[0]?.fields.map((f) => f.label)).toEqual(['id', 'owner']);
  });

  test('secret-looking fields are still stripped', () => {
    const discord = groupAccounts(PAYLOAD).find((g) => g.station === 'discord');
    expect(discord?.rows[0]?.fields.map((f) => f.label)).toEqual(['id']);
  });

  test('an account with no agent id reads as unattributed', () => {
    const groups = groupAccounts({ telegram: [{ id: 'orphan' }] });
    expect(groups[0]?.rows[0]?.agentId).toBeNull();
    expect(unattributedAccounts(groups)).toBe(1);
  });
});

describe('accountsForAgent', () => {
  test('returns only the selected agent accounts', () => {
    const groups = accountsForAgent(groupAccounts(PAYLOAD), 1);
    expect(groups.map((g) => g.station)).toEqual(['discord', 'telegram']);
    expect(groups.flatMap((g) => g.rows.map((r) => r.fields[0]?.value))).toEqual([
      'ada-dc',
      'ada-tg',
    ]);
  });

  test('a station with none of this agent accounts is dropped entirely', () => {
    const groups = accountsForAgent(groupAccounts(PAYLOAD), 2);
    expect(groups.map((g) => g.station)).toEqual(['telegram']);
    expect(groups[0]?.rows).toHaveLength(1);
  });

  test('an agent with no accounts gets an empty list, never someone else rows', () => {
    expect(accountsForAgent(groupAccounts(PAYLOAD), 99)).toEqual([]);
    expect(countAccounts(groupAccounts(PAYLOAD), 99)).toBe(0);
  });

  test('unattributed rows belong to no agent', () => {
    const groups = groupAccounts({ telegram: [{ id: 'orphan' }] });
    expect(accountsForAgent(groups, 1)).toEqual([]);
  });
});

describe('countAccounts', () => {
  test('counts across stations for one agent only', () => {
    const groups = groupAccounts(PAYLOAD);
    expect(countAccounts(groups, 1)).toBe(2);
    expect(countAccounts(groups, 2)).toBe(1);
  });
});

describe('attributeUntagged', () => {
  test('fills in the sole agent id when an older daemon sent none', () => {
    const groups = attributeUntagged(groupAccounts({ telegram: [{ id: 'a' }] }), 4);
    expect(groups[0]?.rows[0]?.agentId).toBe(4);
    expect(accountsForAgent(groups, 4)).toHaveLength(1);
    expect(unattributedAccounts(groups)).toBe(0);
  });

  test('never overwrites an agent id the daemon did send', () => {
    const groups = attributeUntagged(groupAccounts(PAYLOAD), 4);
    expect(groups.flatMap((g) => g.rows.map((r) => r.agentId))).toEqual([1, 1, 2]);
  });
});
