import { describe, expect, test } from 'bun:test';
import { carryForward, type AccountGroup } from '../src/api/accounts.js';
import { boxKey, dropAccount } from '../src/api/queries.js';
import { QueryClient } from '@tanstack/react-query';
import type { StationsView } from '../src/api/client.js';

const row = (id: string) => ({ id, fields: [] });

const PREV: AccountGroup[] = [
  { station: 'xmtp', rows: [row('x0'), row('x1'), row('tony')] },
  { station: 'telegram-bot', rows: [row('t0')] },
];

describe('a station that could not be reached keeps its last known cards', () => {
  test('an unavailable station is carried forward from the cache', () => {
    const fresh: AccountGroup[] = [{ station: 'telegram-bot', rows: [row('t0')] }];
    const out = carryForward(fresh, PREV, ['xmtp']);
    const xmtp = out.find((g) => g.station === 'xmtp');
    expect(xmtp?.rows.map((r) => r.id)).toEqual(['x0', 'x1', 'tony']);
    expect(out.find((g) => g.station === 'telegram-bot')?.rows).toHaveLength(1);
    expect(xmtp?.stale).toBe(true);
    expect(out.find((g) => g.station === 'telegram-bot')?.stale).toBeUndefined();
  });

  test('a reachable station always wins, even when it is now empty', () => {
    const fresh: AccountGroup[] = [{ station: 'telegram-bot', rows: [] }];
    const out = carryForward(fresh, PREV, []);
    expect(out).toBe(fresh);
  });

  test('a station with nothing to carry forward disappears', () => {
    const out = carryForward([], [{ station: 'xmtp', rows: [] }], ['xmtp']);
    expect(out).toEqual([]);
  });
});

describe('a detached account cannot be resurrected by carry-forward', () => {
  const view = (groups: AccountGroup[]): StationsView => ({
    agent: undefined,
    groups,
    attachable: [],
    unavailable: ['xmtp'],
    capabilities: {},
  });

  test('dropAccount removes it from the cache, so the next merge cannot bring it back', () => {
    const client = new QueryClient();
    client.setQueryData<StationsView>(boxKey('stations'), view(PREV));

    dropAccount(client, 'xmtp', 'x0');

    const cached = client.getQueryData<StationsView>(boxKey('stations'));
    const kept = cached?.groups.find((g) => g.station === 'xmtp');
    expect(kept?.rows.map((r) => r.id)).toEqual(['x1', 'tony']);

    const merged = carryForward([], cached?.groups ?? [], ['xmtp', 'telegram-bot']);
    expect(
      merged.find((g) => g.station === 'xmtp')?.rows.map((r) => r.id),
    ).toEqual(['x1', 'tony']);
  });

  test('dropping the last row of a station removes the station', () => {
    const client = new QueryClient();
    client.setQueryData<StationsView>(
      boxKey('stations'),
      view([{ station: 'telegram-bot', rows: [row('t0')] }]),
    );
    dropAccount(client, 'telegram-bot', 't0');
    expect(client.getQueryData<StationsView>(boxKey('stations'))?.groups).toEqual([]);
  });
});

describe('a carried-forward station is marked, not passed off as healthy', () => {
  test('the stale flag survives the flatten the list renders from', async () => {
    const { flattenAccounts } = await import(
      '../src/api/accounts'
    );
    const fresh: AccountGroup[] = [{ station: 'telegram-bot', rows: [row('t0')] }];
    const out = carryForward(fresh, PREV, ['xmtp']);
    const flat = flattenAccounts(out);
    expect(flat.filter((f) => f.stale).map((f) => f.station)).toEqual([
      'xmtp',
      'xmtp',
      'xmtp',
    ]);
    expect(flat.filter((f) => !f.stale).map((f) => f.station)).toEqual([
      'telegram-bot',
    ]);
    expect(out.find((g) => g.station === 'xmtp')?.stale).toBe(true);
  });
});

describe('a switched-off channel on a station without a train stays listed', () => {
  const account = (id: string, enabled: boolean, handle?: string) => ({
    id,
    allowlist: null,
    approvers: [],
    enabled,
    policy: {},
    fields: handle === undefined ? [{ label: 'id', value: id }] : [{ label: 'id', value: id }, { label: 'handle', value: handle }],
  });

  test('with nothing cached, the known accounts the box reports are listed, still off', () => {
    const fresh: AccountGroup[] = [
      { station: 'telegram', rows: [account('tg1', false)] },
      { station: 'xmtp', rows: [account('x0', true)] },
    ];
    const out = carryForward(fresh, [], ['telegram']);
    const telegram = out.find((g) => g.station === 'telegram');
    expect(telegram?.rows.map((r) => [r.id, r.enabled])).toEqual([['tg1', false]]);
    expect(telegram?.stale).toBe(true);
    expect(out.find((g) => g.station === 'xmtp')?.rows).toHaveLength(1);
  });

  test('a cached card keeps its handle and takes the switch the box reports now', () => {
    const prev: AccountGroup[] = [{ station: 'telegram', rows: [account('tg1', true, '@ada')] }];
    const fresh: AccountGroup[] = [{ station: 'telegram', rows: [account('tg1', false)] }];
    const [telegram] = carryForward(fresh, prev, ['telegram']);
    expect(telegram?.rows[0]?.enabled).toBe(false);
    expect(telegram?.rows[0]?.fields.find((f) => f.label === 'handle')?.value).toBe('@ada');
  });

  test('an account the box no longer knows is not brought back from the cache', () => {
    const prev: AccountGroup[] = [{ station: 'telegram', rows: [account('tg1', true), account('gone', true)] }];
    const fresh: AccountGroup[] = [{ station: 'telegram', rows: [account('tg1', false)] }];
    const [telegram] = carryForward(fresh, prev, ['telegram']);
    expect(telegram?.rows.map((r) => r.id)).toEqual(['tg1']);
  });
});
