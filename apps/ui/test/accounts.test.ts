import { describe, expect, test } from 'bun:test';
import {
  accountsForAgent,
  attributeUntagged,
  groupAccounts,
  stationFields,
  unattributedAccounts,
  type AccountRow,
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

  test('the station-local account id is kept for detaching, never invented', () => {
    const groups = groupAccounts(PAYLOAD);
    expect(
      groups.find((g) => g.station === 'telegram')?.rows.map((r) => r.id),
    ).toEqual(['ada-tg', 'bob-tg']);
    expect(groupAccounts({ telegram: [{ owner: 'ada' }] })[0]?.rows[0]?.id).toBeNull();
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
  });

  test('unattributed rows belong to no agent', () => {
    const groups = groupAccounts({ telegram: [{ id: 'orphan' }] });
    expect(accountsForAgent(groups, 1)).toEqual([]);
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

describe('stationFields', () => {
  const row = (fields: Record<string, string>): AccountRow => ({
    id: 'a1-0001',
    agentId: 1,
    fields: Object.entries(fields).map(([label, value]) => ({ label, value })),
  });

  test('identity fields are pulled out and never repeated in the details', () => {
    const f = stationFields(
      row({
        handle: '@metro30593bot',
        url: 'https://t.me/metro30593bot',
        botId: '8798949149',
        connected: 'true',
      }),
    );
    expect(f.handle).toBe('@metro30593bot');
    expect(f.url).toBe('https://t.me/metro30593bot');
    expect(f.details.map((d) => d.label)).toEqual(['botId', 'connected']);
  });

  test('a field the daemon could not fill is dropped, not shown as a dash', () => {
    const f = stationFields(row({ owner: '-', username: 'Metro', env: '' }));
    expect(f.details.map((d) => d.label)).toEqual(['username']);
  });

  test('a missing handle or url is undefined rather than a dash', () => {
    const f = stationFields(row({ handle: '-', inboxId: 'a254b84f' }));
    expect(f.handle).toBeUndefined();
    expect(f.url).toBeUndefined();
    expect(f.details.map((d) => d.label)).toEqual(['inboxId']);
  });

  test('every detail an xmtp account carries survives, in order', () => {
    const f = stationFields(
      row({
        handle: '0x0bA043c6',
        url: 'https://etherscan.io/address/0x0bA043c6',
        address: '0x0bA043c6',
        inboxId: 'a254b84f',
        env: 'production',
      }),
    );
    expect(f.details.map((d) => d.label)).toEqual(['address', 'inboxId', 'env']);
  });
});
