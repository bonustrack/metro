import { describe, expect, test } from 'bun:test';
import type { UserClient } from '../src/client.ts';
import {
  classifyMembers,
  groupAddMembers,
  groupCreate,
  groupInviteLink,
  groupRemoveMembers,
} from '../src/group.ts';

interface Calls {
  created?: { title: string; users: string[] };
  added?: { chatId: number; users: string[] };
  kicked: string[];
}

function fakeClient(opts: {
  chatId?: number;
  missing?: number[];
  link?: string;
  calls: Calls;
}): UserClient {
  return {
    tg: {
      createGroup: (p: { title: string; users: string[] }) => {
        opts.calls.created = p;
        return Promise.resolve({
          chat: { id: opts.chatId ?? 500 },
          missing: (opts.missing ?? []).map((userId) => ({ userId })),
        });
      },
      addChatMembers: (chatId: number, users: string[]) => {
        opts.calls.added = { chatId, users };
        return Promise.resolve((opts.missing ?? []).map((userId) => ({ userId })));
      },
      kickChatMember: (p: { chatId: number; userId: string }) => {
        opts.calls.kicked.push(p.userId);
        return Promise.resolve(null);
      },
      exportInviteLink: (_chatId: number) =>
        Promise.resolve({ link: opts.link ?? 'https://t.me/+invite' }),
      resolvePeer: (_peer: string) => Promise.resolve({}),
    },
  } as unknown as UserClient;
}

describe('telegram-user classifyMembers', () => {
  test('marks missing invitees as invited, the rest as added', async () => {
    const client = fakeClient({ calls: { kicked: [] } });
    const outcomes = await classifyMembers(client, ['111', '222'], [{ userId: 222 }]);
    expect(outcomes).toEqual([
      { id: '111', status: 'added' },
      { id: '222', status: 'invited', reason: expect.stringContaining('invite link') },
    ]);
  });
});

describe('telegram-user groupCreate', () => {
  test('adds who it can and returns an invite link for the rest', async () => {
    const calls: Calls = { kicked: [] };
    const client = fakeClient({ chatId: 900, missing: [222], link: 'https://t.me/+abc', calls });
    const res = await groupCreate(client, 'default', {
      name: 'Support user42',
      members: ['111', '222'],
    });
    expect(calls.created).toEqual({ title: 'Support user42', users: ['111', '222'] });
    expect(res.capability.supported).toBe(true);
    expect(res.line).toBe('metro://telegram-user/default/900');
    expect(res.id).toBe('900');
    expect(res.inviteLink).toBe('https://t.me/+abc');
    expect(res.members).toEqual([
      { id: '111', status: 'added' },
      { id: '222', status: 'invited', reason: expect.any(String) },
    ]);
  });

  test('no invite link when everyone is added', async () => {
    const client = fakeClient({ calls: { kicked: [] } });
    const res = await groupCreate(client, 'default', { name: 'g', members: ['1'] });
    expect(res.inviteLink).toBeUndefined();
    expect(res.members).toEqual([{ id: '1', status: 'added' }]);
  });
});

describe('telegram-user groupAddMembers', () => {
  test('adds members and surfaces an invite link for privacy-blocked ones', async () => {
    const calls: Calls = { kicked: [] };
    const client = fakeClient({ missing: [7], calls });
    const line = 'metro://telegram-user/default/900';
    const res = await groupAddMembers(client, 900, line, { members: ['5', '7'] });
    expect(calls.added).toEqual({ chatId: 900, users: ['5', '7'] });
    expect(res.inviteLink).toBe('https://t.me/+invite');
    expect(res.members).toEqual([
      { id: '5', status: 'added' },
      { id: '7', status: 'invited', reason: expect.any(String) },
    ]);
  });
});

describe('telegram-user groupRemoveMembers', () => {
  test('kicks each member and reports removed', async () => {
    const calls: Calls = { kicked: [] };
    const client = fakeClient({ calls });
    const res = await groupRemoveMembers(client, 900, 'metro://telegram-user/default/900', {
      members: ['5', '7'],
    });
    expect(calls.kicked).toEqual(['5', '7']);
    expect(res.members).toEqual([
      { id: '5', status: 'removed' },
      { id: '7', status: 'removed' },
    ]);
  });
});

describe('telegram-user groupInviteLink', () => {
  test('exports the chat invite link', async () => {
    const client = fakeClient({ link: 'https://t.me/+xyz', calls: { kicked: [] } });
    const res = await groupInviteLink(client, 900, 'metro://telegram-user/default/900');
    expect(res.inviteLink).toBe('https://t.me/+xyz');
    expect(res.capability.supported).toBe(true);
  });
});
