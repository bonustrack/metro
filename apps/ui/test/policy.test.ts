import { describe, expect, test } from 'bun:test';
import {
  effectiveAccess,
  groupAccess,
  overrideCount,
  policyOf,
  toolGroupsOf,
  toolsIn,
  withGroup,
  withTool,
} from '../src/api/policy.ts';
import { approvalOf, splitApprovals, verdictLabel } from '../src/api/approvals.ts';
import { groupAccounts } from '../src/api/accounts.ts';

const SEND = { name: 'send', group: 'write' } as const;
const READ = { name: 'read', group: 'read' } as const;

describe('a channel tool policy on the page', () => {
  test('nothing set means allow, and a tool override beats its group', () => {
    expect(effectiveAccess({}, SEND)).toBe('allow');
    expect(effectiveAccess({ write: 'ask' }, SEND)).toBe('ask');
    expect(effectiveAccess({ write: 'ask', tools: { send: 'deny' } }, SEND)).toBe('deny');
    expect(effectiveAccess({ write: 'deny' }, READ)).toBe('allow');
    expect(groupAccess({ read: 'deny' }, 'read')).toBe('deny');
  });

  test('setting a group keeps the overrides, and Same as group removes one', () => {
    const start = { tools: { send: 'deny' as const } };
    expect(withGroup(start, 'write', 'ask')).toEqual({ tools: { send: 'deny' }, write: 'ask' });
    expect(withTool(start, 'delete', 'ask')).toEqual({ tools: { send: 'deny', delete: 'ask' } });
    expect(withTool(start, 'send', undefined)).toEqual({});
    expect(overrideCount({ tools: { send: 'deny', read: 'ask' } }, [SEND])).toBe(1);
  });

  test('what the daemon sends is read tolerantly', () => {
    expect(policyOf({ read: 'nope', write: 'ask', tools: { send: 'deny', react: 3 } })).toEqual({ write: 'ask', tools: { send: 'deny' } });
    expect(policyOf(null)).toEqual({});
    const groups = toolGroupsOf({ xmtp: [SEND, READ, { name: 'x', group: 'other' }], bad: 'no' });
    expect(groups).toEqual({ xmtp: [SEND, READ], bad: [] });
    expect(toolsIn(groups.xmtp ?? [], 'read')).toEqual([READ]);
  });

  test('an account row carries its policy and never shows it as a detail', () => {
    const [group] = groupAccounts({ xmtp: [{ id: 'x1', policy: { write: 'ask' }, handle: 'x' }] });
    expect(group?.rows[0]?.policy).toEqual({ write: 'ask' });
    expect(group?.rows[0]?.fields.map((f) => f.label)).toEqual(['id', 'handle']);
  });
});

describe('approvals on the page', () => {
  const raw = (id: string, status: string, extra: Record<string, unknown> = {}): unknown => ({
    id,
    tool: 'send',
    label: 'telegram-bot',
    preview: 'in -100, "hi"',
    status,
    requestedAt: '2026-09-24T10:00:00.000Z',
    expiresAt: '2026-09-25T10:00:00.000Z',
    ...extra,
  });

  test('pending ones come first, newest first, and decided ones are recent', () => {
    const list = [
      raw('aaaaa', 'pending'),
      raw('bbbbb', 'approved', { decidedAt: '2026-09-24T11:00:00.000Z', outcome: { ok: true, text: 'sent' } }),
      raw('ccccc', 'pending', { requestedAt: '2026-09-24T12:00:00.000Z', promptLine: 'metro://x' }),
      { id: 'broken' },
    ].flatMap((r) => {
      const a = approvalOf(r);
      return a === null ? [] : [a];
    });
    const { pending, recent } = splitApprovals(list);
    expect(pending.map((a) => a.id)).toEqual(['ccccc', 'aaaaa']);
    expect(pending[0]?.inChat).toBe(true);
    expect(recent.map((a) => a.id)).toEqual(['bbbbb']);
  });

  test('the verdict says how it ended', () => {
    const of = (status: string, outcome?: unknown): string => {
      const a = approvalOf(raw('ddddd', status, outcome === undefined ? {} : { outcome }));
      if (a === null) throw new Error('not an approval');
      return verdictLabel(a);
    };
    expect(of('pending')).toBe('Waiting');
    expect(of('rejected')).toBe('Rejected');
    expect(of('expired')).toBe('Expired');
    expect(of('approved', { ok: true, text: 'sent' })).toBe('Approved');
    expect(of('approved', { ok: false, text: 'Blocked' })).toBe('Approved, failed');
  });
});
