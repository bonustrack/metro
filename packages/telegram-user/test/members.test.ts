import { describe, expect, test } from 'bun:test';
import type { UserClient } from '../src/client.ts';
import {
  fetchMembers,
  isRestricted,
  mapUserMember,
  restrictedMemberList,
} from '../src/members.ts';

describe('telegram-user member mapping', () => {
  test('maps a member with username, display name, title and flags', () => {
    expect(
      mapUserMember({
        user: { id: 9, username: 'less', displayName: 'Less', isBot: false },
        status: 'admin',
        title: 'Boss',
      }),
    ).toEqual({
      id: '9',
      name: 'less',
      display_name: 'Less',
      roles: ['Boss'],
      is_admin: true,
      is_bot: false,
    });
  });

  test('isRestricted recognises admin/permission errors', () => {
    expect(isRestricted('CHAT_ADMIN_REQUIRED')).toBe(true);
    expect(isRestricted('some other error')).toBe(false);
  });

  test('restrictedMemberList is unsupported + empty', () => {
    expect(restrictedMemberList('nope').capability.supported).toBe(false);
  });
});

function fakeClient(pages: Record<number, { rows: unknown[]; total: number }>): UserClient {
  return {
    tg: {
      getChatMembers: (_id: number, p: { offset: number; limit: number }) => {
        const page = pages[p.offset] ?? { rows: [], total: 0 };
        const arr = page.rows.slice() as unknown[] & { total?: number };
        arr.total = page.total;
        return Promise.resolve(arr);
      },
    },
  } as unknown as UserClient;
}

const row = (id: number): unknown => ({
  user: { id, username: `u${id}`, displayName: `U${id}` },
  status: 'member',
});

describe('telegram-user fetchMembers pagination', () => {
  test('pages across offsets until total is reached and marks complete', async () => {
    const client = fakeClient({
      0: { rows: Array.from({ length: 200 }, (_, i) => row(i)), total: 300 },
      200: { rows: Array.from({ length: 100 }, (_, i) => row(200 + i)), total: 300 },
    });
    const list = await fetchMembers(client, 123, 1000);
    expect(list.members).toHaveLength(300);
    expect(list.capability).toEqual({
      supported: true,
      complete: true,
      total: 300,
    });
  });

  test('respects the requested limit and reports incomplete', async () => {
    const client = fakeClient({
      0: { rows: Array.from({ length: 200 }, (_, i) => row(i)), total: 300 },
    });
    const list = await fetchMembers(client, 123, 200);
    expect(list.members).toHaveLength(200);
    expect(list.capability.complete).toBe(false);
    expect(list.capability.total).toBe(300);
  });
});
