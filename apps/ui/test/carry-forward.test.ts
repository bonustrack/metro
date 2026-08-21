import { describe, expect, test } from 'bun:test';
import { carryForward, type AccountGroup } from '../src/api/accounts';
import { dropAccount, stationsKey } from '../src/api/queries';
import { QueryClient } from '@tanstack/react-query';
import type { StationsView } from '../src/api/client';

const row = (id: string) => ({ id, agentId: 'agent000001', fields: [] });

const PREV: AccountGroup[] = [
  { station: 'xmtp', rows: [row('x0'), row('x1'), row('tony')] },
  { station: 'telegram', rows: [row('t0')] },
];

describe('a station that could not be reached keeps its last known cards', () => {
  test('an unavailable station is carried forward from the cache', () => {
    const fresh: AccountGroup[] = [{ station: 'telegram', rows: [row('t0')] }];
    const out = carryForward(fresh, PREV, ['xmtp']);
    const xmtp = out.find((g) => g.station === 'xmtp');
    expect(xmtp?.rows.map((r) => r.id)).toEqual(['x0', 'x1', 'tony']);
    expect(out.find((g) => g.station === 'telegram')?.rows).toHaveLength(1);
  });

  test('a reachable station always wins, even when it is now empty', () => {
    const fresh: AccountGroup[] = [{ station: 'telegram', rows: [] }];
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
    email: 'a@b.c',
    endpoint: '',
    agents: [],
    groups,
    unattributed: 0,
    attachable: [],
    unavailable: ['xmtp'],
    capabilities: {},
  });

  test('dropAccount removes it from the cache, so the next merge cannot bring it back', () => {
    const client = new QueryClient();
    client.setQueryData<StationsView>(stationsKey(), view(PREV));

    dropAccount(client, 'xmtp', 'x0');

    const cached = client.getQueryData<StationsView>(stationsKey());
    const kept = cached?.groups.find((g) => g.station === 'xmtp');
    expect(kept?.rows.map((r) => r.id)).toEqual(['x1', 'tony']);

    const merged = carryForward([], cached?.groups ?? [], ['xmtp', 'telegram']);
    expect(
      merged.find((g) => g.station === 'xmtp')?.rows.map((r) => r.id),
    ).toEqual(['x1', 'tony']);
  });

  test('dropping the last row of a station removes the station', () => {
    const client = new QueryClient();
    client.setQueryData<StationsView>(
      stationsKey(),
      view([{ station: 'telegram', rows: [row('t0')] }]),
    );
    dropAccount(client, 'telegram', 't0');
    expect(client.getQueryData<StationsView>(stationsKey())?.groups).toEqual([]);
  });
});
