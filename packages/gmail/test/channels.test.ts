import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ChannelList } from '@metro-labs/core/stations/channel-directory';
import { Account, accounts } from '../src/accounts.ts';
import { handleCall } from '../src/actions.ts';
import { gmailStation } from '../src/station.ts';
import { capture, fakeFetch, json, USER, useFakeGoogle, type Route, type Seen } from './fake.ts';

let cap: ReturnType<typeof capture>;
let seen: Seen[];

const config = (id = 'g1') => ({
  id, accountEmail: 'fixture@example.test', clientId: 'fixture-client', clientSecret: 'fixture-secret',
  refreshToken: 'fixture-refresh', accessToken: 'fixture-access', expiresAt: Date.now() + 3_600_000,
});

function boot(routes: Route[]): Account {
  const fake = fakeFetch(routes);
  seen = fake.seen;
  const account = new Account(config(), fake.fetch);
  accounts.set(account.id, account);
  accounts.set('g2', new Account(config('g2'), fake.fetch));
  return account;
}

const call = (args: Record<string, unknown> = {}): Promise<void> =>
  handleCall({ op: 'call', id: 'discovery', action: 'listChannels', args: { account: 'g1', ...args } });
const result = (): ChannelList => cap.written.responses.at(-1)?.result as ChannelList;
const error = (): string => String(cap.written.responses.at(-1)?.error ?? '');
const listRoute = (page: Record<string, unknown>): Route => (req) => req.url.startsWith(`${USER}/threads?`) ? json(page) : undefined;
const subjectRoute = (subjects: Record<string, string>): Route => (req) => {
  const url = new URL(req.url);
  const id = url.pathname.split('/').at(-1) ?? '';
  const subject = subjects[id];
  if (!url.pathname.includes('/threads/') || subject === undefined) return undefined;
  expect(url.searchParams.get('format')).toBe('metadata');
  expect(url.searchParams.getAll('metadataHeaders')).toEqual(['Subject']);
  expect(url.searchParams.get('fields')).toBe('messages(payload(headers(name,value)))');
  return json({
    messages: [{ payload: { headers: [{ name: 'Subject', value: subject }], body: { data: 'private body' } }, snippet: 'private preview' }],
    snippet: 'private thread preview',
  });
};

beforeEach(() => {
  useFakeGoogle();
  accounts.clear();
  cap = capture();
});

afterEach(() => {
  cap.restore();
  accounts.clear();
});

describe('Gmail metadata channel discovery', () => {
  test('discovers quiet mailbox threads before inbound sync with Subject-only field masks', async () => {
    const account = boot([
      listRoute({ threads: [{ id: 'quiet' }, { id: 'untitled' }] }),
      subjectRoute({ quiet: 'Quiet Project', untitled: '' }),
    ]);
    await call();
    expect(gmailStation.discoversChannels).toBe(true);
    expect(error()).toBe('');
    expect(result().channels).toEqual([
      { id: 'quiet', line: 'metro://gmail/g1/quiet', kind: 'thread', name: 'Quiet Project' },
      { id: 'untitled', line: 'metro://gmail/g1/untitled', kind: 'thread' },
    ]);
    expect(result().capability).toMatchObject({ supported: true, complete: true, source: 'remote' });
    expect(result().capability.reason).toContain('excluding Spam and Trash');
    const url = new URL(seen[0]?.url ?? '');
    expect(url.searchParams.get('maxResults')).toBe('100');
    expect(url.searchParams.get('fields')).toBe('threads(id),nextPageToken');
    expect(url.searchParams.has('q')).toBe(false);
    expect(seen.every((request) => request.method === 'GET' && request.url.includes('/threads'))).toBe(true);
    expect(JSON.stringify(result())).not.toContain('private');
    expect(cap.written.events).toEqual([]);
    expect(account.state.historyId).toBeNull();
  });

  test('pages without duplicate or lost threads and does not refetch duplicate subjects', async () => {
    boot([
      (req) => req.url.startsWith(`${USER}/threads?`)
        ? json(req.url.includes('pageToken=second')
          ? { threads: [{ id: 'b' }, { id: 'c' }] }
          : { threads: [{ id: 'a' }, { id: 'a' }, { id: 'b' }], nextPageToken: 'second' })
        : undefined,
      subjectRoute({ a: 'First', b: 'Second', c: 'Third' }),
    ]);
    await call({ limit: 1 });
    const first = result();
    expect(first.channels.map((entry) => entry.id)).toEqual(['a']);
    expect(first.next_cursor).not.toBe('second');
    const requests = seen.length;
    await call({ limit: 1, cursor: first.next_cursor });
    const second = result();
    expect(second.channels.map((entry) => entry.id)).toEqual(['b']);
    expect(seen.length).toBe(requests);
    await call({ limit: 1, cursor: second.next_cursor });
    const third = result();
    expect(third.channels.map((entry) => entry.id)).toEqual(['c']);
    expect(third.capability.complete).toBe(true);
    expect(third.next_cursor).toBeUndefined();
    expect(seen.filter((request) => request.url.includes('/threads/b?'))).toHaveLength(1);
    const completed = seen.length;
    await call({ limit: 1, cursor: second.next_cursor });
    expect(result()).toEqual(third);
    expect(seen.length).toBe(completed);
  });

  test('supports empty matching pages, literal subject/id search and long subject matches', async () => {
    boot([
      (req) => req.url.startsWith(`${USER}/threads?`)
        ? json(req.url.includes('pageToken=second')
          ? { threads: [{ id: 'target' }] }
          : { threads: [{ id: 'unrelated' }], nextPageToken: 'second' })
        : undefined,
      subjectRoute({ unrelated: 'Other', target: `${'x'.repeat(300)} Quiet Project` }),
    ]);
    await call({ query: '  QUIET PROJECT  ' });
    const first = result();
    expect(first.channels).toEqual([]);
    expect(first.next_cursor).toBeString();
    await call({ query: 'quiet project', cursor: first.next_cursor });
    expect(result().channels.map((entry) => entry.id)).toEqual(['target']);
    expect(result().channels[0]?.name).toHaveLength(256);
    expect(result().capability.complete).toBe(true);
    expect(seen.every((request) => !new URL(request.url).searchParams.has('q'))).toBe(true);
    await call({ query: 'UNRELATED' });
    expect(result().channels.map((entry) => entry.id)).toEqual(['unrelated']);
    await call({ query: 'subject:Other' });
    expect(result().channels).toEqual([]);
  });

  test('requires an explicit account and rejects cursor scope changes before remote calls', async () => {
    boot([listRoute({ threads: [{ id: 'a' }], nextPageToken: 'second' }), subjectRoute({ a: 'Invoice' })]);
    await call();
    const cursor = result().next_cursor;
    const requests = seen.length;
    for (const args of [{ account: 'g2', cursor }, { query: 'changed', cursor }, { cursor: 'invented' }]) {
      await call(args);
      expect(error()).toContain('Invalid or expired');
    }
    await call({ account: undefined, line: 'metro://gmail/g1/a' });
    expect(error()).toContain('account is required');
    await call({ account: 'missing' });
    expect(error()).toContain('unknown account');
    await call({ limit: 101 });
    expect(error()).toContain('limit');
    expect(seen.length).toBe(requests);
  });

  test('removing or replacing an account invalidates its buffered channel cursors', async () => {
    boot([listRoute({ threads: [{ id: 'old-a' }, { id: 'old-b' }] }), subjectRoute({ 'old-a': 'Old first', 'old-b': 'Old private subject' })]);
    await call({ limit: 1 });
    const cursor = result().next_cursor;
    expect(cursor).toBeString();
    accounts.delete('g1');
    await call({ cursor });
    expect(error()).toContain('unknown account');
    expect(seen).toHaveLength(3);
    boot([listRoute({ threads: [{ id: 'new' }] }), subjectRoute({ new: 'Replacement mailbox' })]);
    await call({ cursor });
    expect(error()).toContain('Invalid or expired');
    expect(cap.written.responses.at(-1)?.result).toBeUndefined();
    expect(seen).toHaveLength(0);
    await call();
    expect(error()).toBe('');
    expect(result().channels.map((entry) => entry.name)).toEqual(['Replacement mailbox']);
  });

  test('an empty mailbox is supported without pretending to require received messages', async () => {
    boot([listRoute({})]);
    await call();
    expect(result().channels).toEqual([]);
    expect(result().capability).toMatchObject({ supported: true, complete: true, source: 'remote' });
    expect(result().next_cursor).toBeUndefined();
    expect(seen).toHaveLength(1);
  });

  test('caps remote scans and reports that an unmatched query did not search the whole mailbox', async () => {
    let pages = 0;
    boot([
      (req) => req.url.startsWith(`${USER}/threads?`)
        ? json({ threads: Array.from({ length: 100 }, () => ({ id: 'duplicate' })), nextPageToken: `page-${++pages}` })
        : undefined,
      subjectRoute({ duplicate: 'Other subject' }),
    ]);
    await call({ query: 'missing' });
    while (result().next_cursor) await call({ query: 'missing', cursor: result().next_cursor });
    expect(pages).toBe(50);
    expect(result().channels).toEqual([]);
    expect(result().capability.complete).toBe(false);
    expect(result().capability.reason).toContain('5000');
    expect(result().capability.reason).toContain('does not cover the whole mailbox');
    expect(seen.filter((request) => request.url.includes('/threads/duplicate?'))).toHaveLength(1);
  });

  test('bounds Subject fetch concurrency and shares one nonredirecting request deadline', async () => {
    let active = 0;
    let peak = 0;
    const signals = new Set<AbortSignal>();
    const fake = fakeFetch([
      listRoute({ threads: Array.from({ length: 23 }, (_, i) => ({ id: `thread-${i}` })) }),
      async (req) => {
        if (!req.url.includes('/threads/')) return undefined;
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
        return json({ messages: [{ payload: { headers: [{ name: 'Subject', value: 'Fixture' }] } }] });
      },
    ]);
    accounts.set('g1', new Account(config(), (input, init) => {
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (init?.signal) signals.add(init.signal);
      return fake.fetch(input, init);
    }));
    await call({ limit: 1 });
    expect(error()).toBe('');
    expect(result().channels).toHaveLength(1);
    expect(result().next_cursor).toBeString();
    expect(peak).toBe(10);
    expect(signals.size).toBe(1);
    expect(fake.seen).toHaveLength(24);
  });

  test('surfaces metadata errors instead of claiming an empty or complete directory', async () => {
    boot([listRoute({ threads: [{ id: 'gone' }] }), (req) => req.url.includes('/threads/gone?') ? json({ error: { message: 'not available' } }, 404) : undefined]);
    await call();
    expect(error()).toContain('not available');
    expect(cap.written.responses.at(-1)?.result).toBeUndefined();
  });
});
