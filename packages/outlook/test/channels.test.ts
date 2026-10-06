import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ChannelList } from '@metro-labs/core/stations/channel-directory';
import { Account, accounts } from '../src/accounts.ts';
import { handleCall } from '../src/actions.ts';
import { outlookStation } from '../src/station.ts';
import { capture, fakeFetch, GRAPH, json, useFakeMicrosoft, type Route, type Seen } from './fake.ts';

let cap: ReturnType<typeof capture>;
let seen: Seen[];

const config = (id = 'o1') => ({
  id, accountEmail: 'fixture@example.test', refreshToken: 'fixture-refresh',
  accessToken: 'fixture-access', expiresAt: Date.now() + 3_600_000,
});

function boot(routes: Route[]): Account {
  const fake = fakeFetch(routes);
  seen = fake.seen;
  const account = new Account(config(), fake.fetch);
  accounts.set(account.id, account);
  accounts.set('o2', new Account(config('o2'), fake.fetch));
  return account;
}

const call = (args: Record<string, unknown> = {}): Promise<void> =>
  handleCall({ op: 'call', id: 'discovery', action: 'listChannels', args: { account: 'o1', ...args } });
const result = (): ChannelList => cap.written.responses.at(-1)?.result as ChannelList;
const error = (): string => String(cap.written.responses.at(-1)?.error ?? '');
const listRoute = (page: Record<string, unknown>): Route => (req) => req.url.startsWith(`${GRAPH}/me/messages?`) ? json(page) : undefined;
const message = (conversationId: string, subject: string) => ({
  conversationId, subject, bodyPreview: 'private preview', body: { content: 'private body' },
  from: { emailAddress: { address: 'private@example.test' } }, hasAttachments: true, isRead: false,
});

beforeEach(() => {
  useFakeMicrosoft();
  accounts.clear();
  cap = capture();
});

afterEach(() => {
  cap.restore();
  accounts.clear();
});

describe('Outlook metadata channel discovery', () => {
  test('discovers quiet conversations before inbound sync with only id and subject metadata', async () => {
    const account = boot([listRoute({ value: [message('AAQkAD/abc+def%=', 'Quiet Project'), message('untitled', '')] })]);
    await call();
    expect(outlookStation.discoversChannels).toBe(true);
    expect(error()).toBe('');
    expect(result().channels).toEqual([
      { id: 'AAQkAD/abc+def%=', line: 'metro://outlook/o1/AAQkAD%2Fabc%2Bdef%25=', kind: 'thread', name: 'Quiet Project' },
      { id: 'untitled', line: 'metro://outlook/o1/untitled', kind: 'thread' },
    ]);
    expect(result().capability).toMatchObject({ supported: true, complete: true, source: 'remote' });
    const url = new URL(seen[0]?.url ?? '');
    expect(url.searchParams.get('$select')).toBe('conversationId,subject');
    expect(url.searchParams.get('$orderby')).toBe('receivedDateTime desc');
    expect(url.searchParams.get('$top')).toBe('100');
    expect([...url.searchParams.keys()].sort()).toEqual(['$orderby', '$select', '$top']);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.body).toBe('');
    expect(JSON.stringify(result())).not.toContain('private');
    expect(cap.written.events).toEqual([]);
    expect(account.state.deltaLink).toBeNull();
  });

  test('deduplicates across native pages, preserves leftovers and replays without extra requests', async () => {
    boot([(req) => req.url.startsWith(`${GRAPH}/me/messages?`)
      ? json(new URL(req.url).searchParams.has('$skip')
        ? { value: [message('a', 'Older subject'), message('c', 'Third')] }
        : { value: [message('a', 'Newest subject'), message('a', 'Repeated subject'), message('b', 'Second')], '@odata.nextLink': `${GRAPH}/me/messages?$skip=3` })
      : undefined]);
    await call({ limit: 1 });
    const first = result();
    expect(first.channels.map((entry) => entry.name)).toEqual(['Newest subject']);
    expect(first.next_cursor).not.toContain('graph.test');
    await call({ limit: 1, cursor: first.next_cursor });
    const second = result();
    expect(second.channels.map((entry) => entry.id)).toEqual(['b']);
    expect(seen).toHaveLength(1);
    await call({ limit: 1, cursor: second.next_cursor });
    const third = result();
    expect(third.channels.map((entry) => entry.id)).toEqual(['c']);
    expect(third.capability.complete).toBe(true);
    expect(third.next_cursor).toBeUndefined();
    expect(seen).toHaveLength(2);
    const url = new URL(seen[1]?.url ?? '');
    expect(url.searchParams.get('$skip')).toBe('3');
    expect(url.searchParams.get('$select')).toBe('conversationId,subject');
    await call({ limit: 1, cursor: second.next_cursor });
    expect(result()).toEqual(third);
    expect(seen).toHaveLength(2);
  });

  test('filters literal subject/id substrings locally and resumes empty matching pages', async () => {
    boot([(req) => req.url.startsWith(`${GRAPH}/me/messages?`)
      ? json(new URL(req.url).searchParams.has('$skiptoken')
        ? { value: [message('target', `${'x'.repeat(300)} Quiet Project`)] }
        : { value: [message('unrelated', 'Other')], '@odata.nextLink': `${GRAPH}/me/messages?$skiptoken=opaque-token` })
      : undefined]);
    await call({ query: ' QUIET PROJECT ' });
    const first = result();
    expect(first.channels).toEqual([]);
    expect(first.capability.complete).toBe(false);
    expect(first.next_cursor).toBeString();
    await call({ query: 'quiet project', cursor: first.next_cursor });
    expect(result().channels.map((entry) => entry.id)).toEqual(['target']);
    expect(result().channels[0]?.name).toHaveLength(256);
    expect(result().capability.complete).toBe(true);
    await call({ query: 'UNRELATED' });
    expect(result().channels.map((entry) => entry.id)).toEqual(['unrelated']);
    await call({ query: 'subject:Other' });
    expect(result().channels).toEqual([]);
    expect(seen.every((request) => !new URL(request.url).searchParams.has('$search'))).toBe(true);
    expect(seen.every((request) => request.method === 'GET')).toBe(true);
  });

  test('binds cursors to account/query and requires an explicit account before I/O', async () => {
    boot([listRoute({ value: [message('a', 'Invoice')], '@odata.nextLink': `${GRAPH}/me/messages?$skip=1` })]);
    await call();
    const cursor = result().next_cursor;
    for (const args of [{ account: 'o2', cursor }, { query: 'changed', cursor }, { cursor: 'invented' }]) {
      await call(args);
      expect(error()).toContain('Invalid or expired');
    }
    await call({ account: undefined, line: 'metro://outlook/o1/a' });
    expect(error()).toContain('account is required');
    await call({ account: 'missing' });
    expect(error()).toContain('unknown account');
    await call({ limit: 101 });
    expect(error()).toContain('limit');
    expect(seen).toHaveLength(1);
  });

  test('removing or replacing an account invalidates its buffered channel cursors', async () => {
    boot([listRoute({ value: [message('old-a', 'Old first'), message('old-b', 'Old private subject')] })]);
    await call({ limit: 1 });
    const cursor = result().next_cursor;
    expect(cursor).toBeString();
    accounts.delete('o1');
    await call({ cursor });
    expect(error()).toContain('unknown account');
    expect(seen).toHaveLength(1);
    boot([listRoute({ value: [message('new', 'Replacement mailbox')] })]);
    await call({ cursor });
    expect(error()).toContain('Invalid or expired');
    expect(cap.written.responses.at(-1)?.result).toBeUndefined();
    expect(seen).toHaveLength(0);
    await call();
    expect(error()).toBe('');
    expect(result().channels.map((entry) => entry.name)).toEqual(['Replacement mailbox']);
  });

  test('never follows nextLinks outside the configured metadata endpoint or with body fields', async () => {
    const links = [
      'https://elsewhere.test/v1.0/me/messages?$skip=1',
      `${GRAPH}/users/other/messages?$skip=1`,
      `${GRAPH}/me/messages/one/attachments`,
      `${GRAPH}/me/messages?$select=conversationId,subject,body`,
      `${GRAPH}/me/messages?$expand=attachments`,
      `${GRAPH}/me/messages?$select=conversationId,subject&$select=body`,
      `${GRAPH}/me/messages?$search=private`,
      `${GRAPH}/me/messages#fragment`,
      'https://user:password@graph.test/v1.0/me/messages',
    ];
    for (const link of links) {
      boot([listRoute({ value: [], '@odata.nextLink': link })]);
      await call();
      expect(error()).toContain('unsafe metadata page link');
      expect(cap.written.responses.at(-1)?.result).toBeUndefined();
      expect(seen).toHaveLength(1);
      expect(seen[0]?.url).toStartWith(`${GRAPH}/me/messages?`);
    }
  });

  test('bounds the message scan, not the number of unique conversations', async () => {
    let pages = 0;
    boot([(req) => req.url.startsWith(`${GRAPH}/me/messages?`)
      ? json({ value: Array.from({ length: 100 }, () => message('duplicate', 'Other')), '@odata.nextLink': `${GRAPH}/me/messages?$skip=${++pages * 100}` })
      : undefined]);
    await call({ query: 'missing' });
    while (result().next_cursor) await call({ query: 'missing', cursor: result().next_cursor });
    expect(pages).toBe(50);
    expect(result().channels).toEqual([]);
    expect(result().capability.complete).toBe(false);
    expect(result().capability.reason).toContain('5000');
    expect(result().capability.reason).toContain('does not cover the whole mailbox');
    expect(seen.every((request) => request.method === 'GET' && request.url.includes('/me/messages?'))).toBe(true);
  });

  test('supports empty mailboxes and surfaces provider errors instead of returning false completeness', async () => {
    boot([listRoute({ value: [] })]);
    await call();
    expect(result().channels).toEqual([]);
    expect(result().capability).toMatchObject({ supported: true, complete: true, source: 'remote' });
    boot([(req) => req.url.startsWith(`${GRAPH}/me/messages?`) ? json({ error: { message: 'denied' } }, 403) : undefined]);
    await call();
    expect(error()).toContain('denied');
    expect(cap.written.responses.at(-1)?.result).toBeUndefined();
  });
});
