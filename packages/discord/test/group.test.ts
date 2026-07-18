import { describe, expect, test } from 'bun:test';
import type { RestFn } from '../src/group.ts';
import {
  groupAddMembers,
  groupCreate,
  groupRemoveMembers,
} from '../src/group.ts';

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

function fakeRest(opts: {
  threadId?: string;
  fail?: (path: string) => boolean;
  calls: Call[];
}): RestFn {
  return (async (_acc: string, method: string, path: string, body?: unknown) => {
    opts.calls.push({ method, path, body });
    if (opts.fail?.(path)) throw new Error('403 Forbidden');
    if (method === 'POST' && path.endsWith('/threads'))
      return { id: opts.threadId ?? 'th1' } as unknown;
    return undefined as unknown;
  }) as RestFn;
}

describe('discord groupCreate', () => {
  test('creates a thread and adds members (one blocked)', async () => {
    const calls: Call[] = [];
    const rest = fakeRest({
      threadId: 'th9',
      fail: (p) => p.endsWith('/thread-members/999'),
      calls,
    });
    const res = await groupCreate(rest, 'acc', 'parentChan', {
      name: 'Support user42',
      members: ['111', '999'],
    });
    expect(res.capability.supported).toBe(true);
    expect(res.line).toBe('metro://discord/acc/th9');
    expect(res.id).toBe('th9');
    expect(res.members).toEqual([
      { id: '111', status: 'added' },
      { id: '999', status: 'failed', reason: expect.stringContaining('403') },
    ]);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/channels/parentChan/threads',
    });
  });

  test('missing name returns structured not-supported', async () => {
    const res = await groupCreate(fakeRest({ calls: [] }), 'acc', 'parentChan', {});
    expect(res.capability.supported).toBe(false);
    expect(res.capability.reason).toContain('name');
  });
});

describe('discord groupAddMembers', () => {
  test('PUTs each member onto the thread', async () => {
    const calls: Call[] = [];
    const rest = fakeRest({ calls });
    const res = await groupAddMembers(rest, 'acc', 'th1', 'metro://discord/acc/th1', {
      members: ['1', '2'],
    });
    expect(res.members).toEqual([
      { id: '1', status: 'added' },
      { id: '2', status: 'added' },
    ]);
    expect(calls.map((c) => c.method)).toEqual(['PUT', 'PUT']);
    expect(calls[0]!.path).toBe('/channels/th1/thread-members/1');
  });
});

describe('discord groupRemoveMembers', () => {
  test('DELETEs each member from the thread', async () => {
    const calls: Call[] = [];
    const rest = fakeRest({ calls });
    const res = await groupRemoveMembers(rest, 'acc', 'th1', 'metro://discord/acc/th1', {
      members: ['1'],
    });
    expect(res.members).toEqual([{ id: '1', status: 'removed' }]);
    expect(calls[0]).toMatchObject({
      method: 'DELETE',
      path: '/channels/th1/thread-members/1',
    });
  });
});
