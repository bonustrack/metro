import { describe, expect, test } from 'bun:test';
import type { UserClient } from '../src/client.ts';
import {
  groupAddMembers,
  groupCreate,
  groupInviteLink,
  groupRemoveMembers,
} from '../src/group.ts';

interface Calls {
  created: { title: string; users: string[] }[];
  added: { chatId: number; users: string[] }[];
  kicked: string[];
  exported: number;
}

const ADD_FAILED = 'Telegram API error 400: CHAT_MEMBER_ADD_FAILED';

function fakeClient(opts: {
  chatId?: number;
  missing?: number[];
  blocked?: string[];
  fatal?: string[];
  link?: string;
  calls: Calls;
}): UserClient {
  const blocked = new Set(opts.blocked ?? []);
  const fatal = new Set(opts.fatal ?? []);
  const missingFor = (users: string[]) =>
    (opts.missing ?? [])
      .filter((uid) => users.includes(String(uid)))
      .map((userId) => ({ userId }));
  const gate = (users: string[]) => {
    if (users.some((u) => fatal.has(u)))
      throw new Error('Telegram API error 401: AUTH_KEY_UNREGISTERED');
    if (users.some((u) => blocked.has(u))) throw new Error(ADD_FAILED);
  };
  return {
    tg: {
      createGroup: (p: { title: string; users: string[] }) => {
        opts.calls.created.push(p);
        gate(p.users);
        return Promise.resolve({
          chat: { id: opts.chatId ?? 500 },
          missing: missingFor(p.users),
        });
      },
      addChatMembers: (chatId: number, users: string[]) => {
        opts.calls.added.push({ chatId, users });
        gate(users);
        return Promise.resolve(missingFor(users));
      },
      kickChatMember: (p: { chatId: number; userId: string }) => {
        opts.calls.kicked.push(p.userId);
        return Promise.resolve(null);
      },
      exportInviteLink: (_chatId: number) => {
        opts.calls.exported += 1;
        return Promise.resolve({ link: opts.link ?? 'https://t.me/+invite' });
      },
      resolvePeer: (_peer: string) => Promise.resolve({}),
    },
  } as unknown as UserClient;
}

function calls(): Calls {
  return { created: [], added: [], kicked: [], exported: 0 };
}

describe('telegram-user groupCreate', () => {
  test('surfaces missing invitees as invited with an invite link', async () => {
    const c = calls();
    const client = fakeClient({ chatId: 900, missing: [222], link: 'https://t.me/+abc', calls: c });
    const res = await groupCreate(client, 'default', {
      name: 'Support user42',
      members: ['111', '222'],
    });
    expect(c.created).toEqual([{ title: 'Support user42', users: ['111', '222'] }]);
    expect(res.capability.supported).toBe(true);
    expect(res.line).toBe('metro://telegram-user/default/900');
    expect(res.id).toBe('900');
    expect(res.name).toBe('Support user42');
    expect(res.inviteLink).toBe('https://t.me/+abc');
    expect(res.members).toEqual([
      { id: '111', status: 'added' },
      { id: '222', status: 'invited', reason: expect.stringContaining('invite link') },
    ]);
  });

  test('degrades per-member when createGroup hard-errors on an un-addable member', async () => {
    const c = calls();
    const client = fakeClient({ chatId: 900, blocked: ['222'], link: 'https://t.me/+abc', calls: c });
    const res = await groupCreate(client, 'default', {
      name: 'Test group',
      members: ['111', '222'],
    });
    expect(c.created).toEqual([
      { title: 'Test group', users: ['111', '222'] },
      { title: 'Test group', users: ['111'] },
    ]);
    expect(c.added).toEqual([{ chatId: 900, users: ['222'] }]);
    expect(res.inviteLink).toBe('https://t.me/+abc');
    expect(c.exported).toBe(1);
    expect(res.members).toEqual([
      { id: '111', status: 'added' },
      { id: '222', status: 'invited', reason: expect.any(String) },
    ]);
  });

  test('no invite link when everyone is added', async () => {
    const c = calls();
    const client = fakeClient({ calls: c });
    const res = await groupCreate(client, 'default', { name: 'g', members: ['1'] });
    expect(res.inviteLink).toBeUndefined();
    expect(c.exported).toBe(0);
    expect(res.members).toEqual([{ id: '1', status: 'added' }]);
  });

  test('throws when no requested member can be added', async () => {
    const c = calls();
    const client = fakeClient({ blocked: ['9'], calls: c });
    expect(groupCreate(client, 'default', { name: 'g', members: ['9'] })).rejects.toThrow();
  });
});

describe('telegram-user groupAddMembers', () => {
  test('surfaces an invite link for privacy-blocked (missing) members', async () => {
    const c = calls();
    const client = fakeClient({ missing: [7], calls: c });
    const line = 'metro://telegram-user/default/900';
    const res = await groupAddMembers(client, 900, line, { members: ['5', '7'] });
    expect(c.added).toEqual([
      { chatId: 900, users: ['5'] },
      { chatId: 900, users: ['7'] },
    ]);
    expect(res.inviteLink).toBe('https://t.me/+invite');
    expect(res.members).toEqual([
      { id: '5', status: 'added' },
      { id: '7', status: 'invited', reason: expect.any(String) },
    ]);
  });

  test('degrades per-member when add hard-errors, never throwing', async () => {
    const c = calls();
    const client = fakeClient({ blocked: ['7'], calls: c });
    const line = 'metro://telegram-user/default/900';
    const res = await groupAddMembers(client, 900, line, { members: ['5', '7'] });
    expect(res.inviteLink).toBe('https://t.me/+invite');
    expect(res.members).toEqual([
      { id: '5', status: 'added' },
      { id: '7', status: 'invited', reason: expect.any(String) },
    ]);
  });

  test('rethrows genuine fatal errors', async () => {
    const c = calls();
    const client = fakeClient({ fatal: ['7'], calls: c });
    const line = 'metro://telegram-user/default/900';
    expect(groupAddMembers(client, 900, line, { members: ['7'] })).rejects.toThrow();
  });
});

describe('telegram-user groupRemoveMembers', () => {
  test('kicks each member and reports removed', async () => {
    const c = calls();
    const client = fakeClient({ calls: c });
    const res = await groupRemoveMembers(client, 900, 'metro://telegram-user/default/900', {
      members: ['5', '7'],
    });
    expect(c.kicked).toEqual(['5', '7']);
    expect(res.members).toEqual([
      { id: '5', status: 'removed' },
      { id: '7', status: 'removed' },
    ]);
  });
});

describe('telegram-user groupInviteLink', () => {
  test('exports the chat invite link', async () => {
    const c = calls();
    const client = fakeClient({ link: 'https://t.me/+xyz', calls: c });
    const res = await groupInviteLink(client, 900, 'metro://telegram-user/default/900');
    expect(res.inviteLink).toBe('https://t.me/+xyz');
    expect(res.capability.supported).toBe(true);
  });
});
