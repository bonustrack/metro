import { describe, expect, test } from 'bun:test';
import type { RunEvent, RunEventsPage } from '@metro-labs/client/api/run-events';
import { mergeRunFeed, metroEntry } from '../src/components/run/metro-entries.js';
import { DEFAULT_FILTERS, eventBuckets, filterEntries, filterOptions } from '../src/components/run/filters.js';
import { relatedEntries, type RunEntry } from '../src/components/run/model.js';

const event = (seq: number, extra: Partial<RunEvent> = {}): RunEvent => ({
  id: `event-${String(seq)}`, seq, ts: new Date(1_000_000 + seq * 1_000).toISOString(), kind: 'msg', direction: 'inbound',
  agentId: 'agent-one', station: 'xmtp', accountId: 'account-one', line: 'metro://xmtp/account-one/channel-one',
  from: 'metro://xmtp/account-one/user/sender-one', fromName: 'Alex', text: 'Please check the build', truncated: false, metadata: {}, ...extra,
});
const page = (events: RunEvent[], extra: Partial<RunEventsPage> = {}): RunEventsPage => ({
  events, cursor: 'cursor', hasMore: false, reset: false, retention: { capacity: 500, oldestAt: event(1).ts, oldestSeq: 1 }, ...extra,
});
const entry = (id: string, extra: Partial<RunEntry> = {}): RunEntry => ({ ...metroEntry(event(1), 'Demo agent'), id, ...extra });

describe('Run feed retention', () => {
  test('merges incremental pages by sequence and bounds volatile data', () => {
    const initial = mergeRunFeed(undefined, page(Array.from({ length: 500 }, (_, i) => event(i + 1)), { reset: true }));
    const next = mergeRunFeed(initial, page([event(500), event(501)]));
    expect(next.events).toHaveLength(500);
    expect(next.events[0]?.seq).toBe(2);
    expect(next.events[499]?.seq).toBe(501);
    expect(next.generation).toBe(1);
  });

  test('policy, daemon and expired cursor resets discard previous messages', () => {
    const initial = mergeRunFeed(undefined, page([event(1)], { reset: true }));
    const reset = mergeRunFeed(initial, page([event(2)], { reset: true }));
    expect(reset.events.map((row) => row.seq)).toEqual([2]);
    expect(reset.generation).toBe(2);
  });

  test('evicts records on a quiet poll and clears an empty ring', () => {
    const initial = mergeRunFeed(undefined, page([event(1), event(2)]));
    const quiet = mergeRunFeed(initial, page([], { retention: { capacity: 500, oldestAt: event(2).ts, oldestSeq: 2 } }));
    expect(quiet.events.map((row) => row.seq)).toEqual([2]);
    expect(mergeRunFeed(quiet, page([], { retention: { capacity: 500, oldestAt: null, oldestSeq: null } })).events).toEqual([]);
  });
});

describe('Run event presentation', () => {
  test('preserves real sender, body and source without assigning a worker', () => {
    const row = metroEntry(event(1, { fromDisplayName: 'Alex Morgan', lineName: 'Build', messageId: 'msg-1' }), 'Demo agent');
    expect(row.sender).toBe('Alex Morgan');
    expect(row.text).toBe('Please check the build');
    expect(row.channel).toBe('Build');
    expect(row.account).toBe('account-one');
    expect(row.worker).toBe('Unlinked');
    expect(row.session).toBeNull();
    expect(row.messageId).toBe('msg-1');
  });

  test('outgoing identity comes from agent ID and does not claim worker attribution', () => {
    const row = metroEntry(event(2, { direction: 'outbound', fromName: 'wrong display' }), 'Demo agent');
    expect(row.sender).toBe('Demo agent');
    expect(row.senderId).toBe('agent-one');
    expect(row.status).toBe('Sent');
    expect(row.worker).toBe('Unlinked');
  });

  test('actual reaction removals are not shown as new reactions', () => {
    const row = metroEntry(event(3, { kind: 'react', metadata: { removed: true } }), 'Demo');
    expect(row.text).toBe('Reaction removed.');
    expect(row.metadata).toContainEqual(['removed', 'true']);
  });

  test('system events do not display free-form bodies and unknown metadata', () => {
    const metadata = { attachmentStatus: 'failed' as const, secret: 'must not display' };
    const row = metroEntry(event(3, { kind: 'system', direction: 'system', text: 'not a safe system body', metadata }), 'Demo');
    expect(row.kind).toBe('Error');
    expect(row.text).toBe('Attachment failed.');
    expect(JSON.stringify(row)).not.toContain('must not display');
    expect(JSON.stringify(row)).not.toContain('not a safe system body');
  });
});

describe('Run filtering and links', () => {
  const rows = [entry('one'), entry('two', { sender: 'Jamie', senderId: 'sender-two', text: 'Other task', worker: 'worker-two' })];

  test('combines search and all dimensions without broadening a worker filter', () => {
    const filters = { ...DEFAULT_FILTERS, q: 'BUILD', station: 'xmtp', account: 'account-one', sender: rows[0]!.senderId, channel: rows[0]!.line, direction: 'inbound', time: '5' };
    expect(filterEntries(rows, filters, 1_002_000).map((row) => row.id)).toEqual(['one']);
    expect(filterEntries(rows, { ...filters, worker: 'worker-two' }, 1_002_000)).toEqual([]);
    expect(filterEntries(rows, { ...filters, time: '5' }, 2_000_000)).toEqual([]);
    expect(filterOptions(rows, 'sender').map((option) => option.label)).toEqual(['All senders', 'Alex', 'Jamie']);
  });

  test('same-name channels and people have distinct filter labels', () => {
    const first = entry('first', { channel: 'Demo project' });
    const second = entry('second', { channel: 'Demo project', line: 'metro://telegram/account-two/project', senderId: 'sender-two' });
    const channels = filterOptions([first, second], 'channel');
    expect(new Set(channels.map((option) => option.label)).size).toBe(3);
    expect(channels.find((option) => option.value === second.line)?.label).toContain(second.line);
    expect(new Set(filterOptions([first, second], 'sender').map((option) => option.label)).size).toBe(3);
  });

  test('reply traces stay on the exact line and do not join on timestamp or worker', () => {
    const parent = entry('parent', { messageId: 'msg' });
    const reply = entry('reply', { messageId: 'reply', replyTo: 'msg' });
    const unrelated = entry('other', { line: 'metro://xmtp/account-two/channel-one', messageId: 'msg' });
    expect(relatedEntries(reply, [parent, reply, unrelated]).map((row) => row.id)).toEqual(['parent', 'reply']);
  });

  test('SDK links require the same session and task or tool call', () => {
    const task = entry('task', { session: 'session-a', worker: 'worker-1' });
    const linked = entry('tool', { session: 'session-a', worker: 'worker-1', toolUseId: 'tool-1' });
    const other = entry('other', { session: 'session-b', worker: 'worker-1' });
    expect(relatedEntries(task, [task, linked, other]).map((row) => row.id)).toEqual(['task', 'tool']);
    expect(relatedEntries(entry('main', { session: 'session-a', worker: 'Main' }), [task, linked])).toEqual([]);
  });

  test('chart buckets count only retained events with bounded bins', () => {
    const data = [entry('early', { at: 60_001 }), entry('later', { at: 120_000 }), entry('late', { at: 120_500 })];
    expect(eventBuckets(data).map((bucket) => bucket.count)).toEqual([1, 2]);
    const wide = eventBuckets([...data, entry('days', { at: 10_000_000_000 })]);
    expect(wide.length).toBeLessThanOrEqual(25);
    expect(wide.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(4);
    expect(eventBuckets([])).toEqual([]);
  });
});
