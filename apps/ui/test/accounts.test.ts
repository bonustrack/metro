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
  'telegram-bot': [
    { id: 'ada-tg', owner: 'ada', agentId: 'agent000001' },
    { id: 'bob-tg', owner: 'bob', agentId: 'agent000002' },
  ],
  'discord-bot': [{ id: 'ada-dc', token: 'mk_fake_never_shown', agentId: 'agent000001' }],
  line: [],
};

describe('groupAccounts carries the owning agent', () => {
  test('each row keeps the agent id and never renders it as a field', () => {
    const groups = groupAccounts(PAYLOAD);
    const telegramBot = groups.find((g) => g.station === 'telegram-bot');
    expect(telegramBot?.rows.map((r) => r.agentId)).toEqual(['agent000001', 'agent000002']);
    expect(telegramBot?.rows[0]?.fields.map((f) => f.label)).toEqual(['id', 'owner']);
  });

  test('secret-looking fields are still stripped', () => {
    const discordBot = groupAccounts(PAYLOAD).find((g) => g.station === 'discord-bot');
    expect(discordBot?.rows[0]?.fields.map((f) => f.label)).toEqual(['id']);
  });

  test('the station-local account id is kept for detaching, never invented', () => {
    const groups = groupAccounts(PAYLOAD);
    expect(
      groups.find((g) => g.station === 'telegram-bot')?.rows.map((r) => r.id),
    ).toEqual(['ada-tg', 'bob-tg']);
    expect(groupAccounts({ 'telegram-bot': [{ owner: 'ada' }] })[0]?.rows[0]?.id).toBeNull();
  });

  test('an account with no agent id reads as unattributed', () => {
    const groups = groupAccounts({ 'telegram-bot': [{ id: 'orphan' }] });
    expect(groups[0]?.rows[0]?.agentId).toBeNull();
    expect(unattributedAccounts(groups)).toBe(1);
  });
});

describe('accountsForAgent', () => {
  test('returns only the selected agent accounts', () => {
    const groups = accountsForAgent(groupAccounts(PAYLOAD), 'agent000001');
    expect(groups.map((g) => g.station)).toEqual(['discord-bot', 'telegram-bot']);
    expect(groups.flatMap((g) => g.rows.map((r) => r.fields[0]?.value))).toEqual([
      'ada-dc',
      'ada-tg',
    ]);
  });

  test('a station with none of this agent accounts is dropped entirely', () => {
    const groups = accountsForAgent(groupAccounts(PAYLOAD), 'agent000002');
    expect(groups.map((g) => g.station)).toEqual(['telegram-bot']);
    expect(groups[0]?.rows).toHaveLength(1);
  });

  test('an agent with no accounts gets an empty list, never someone else rows', () => {
    expect(accountsForAgent(groupAccounts(PAYLOAD), 'agent000099')).toEqual([]);
  });

  test('unattributed rows belong to no agent', () => {
    const groups = groupAccounts({ 'telegram-bot': [{ id: 'orphan' }] });
    expect(accountsForAgent(groups, 'agent000001')).toEqual([]);
  });
});

describe('attributeUntagged', () => {
  test('fills in the sole agent id when an older daemon sent none', () => {
    const groups = attributeUntagged(groupAccounts({ 'telegram-bot': [{ id: 'a' }] }), 'agent000004');
    expect(groups[0]?.rows[0]?.agentId).toBe('agent000004');
    expect(accountsForAgent(groups, 'agent000004')).toHaveLength(1);
    expect(unattributedAccounts(groups)).toBe(0);
  });

  test('never overwrites an agent id the daemon did send', () => {
    const groups = attributeUntagged(groupAccounts(PAYLOAD), 'agent000004');
    expect(groups.flatMap((g) => g.rows.map((r) => r.agentId))).toEqual(['agent000001', 'agent000001', 'agent000002']);
  });
});

describe('stationFields', () => {
  const row = (fields: Record<string, string>): AccountRow => ({
    id: 'a1-0001',
    agentId: 'agent000001',
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
