import { describe, expect, test } from 'bun:test';
import {
  adminMemberList,
  inaccessibleMemberList,
  mapTgMember,
} from '../src/members.ts';

describe('telegram (bot) member mapping', () => {
  test('maps an administrator with display name and admin flag', () => {
    expect(
      mapTgMember({
        user: { id: 5, username: 'less', first_name: 'Less', is_bot: false },
        status: 'administrator',
      }),
    ).toEqual({
      id: '5',
      name: 'less',
      display_name: 'Less',
      is_admin: true,
      is_bot: false,
    });
  });

  test('creator is admin; plain member is not', () => {
    expect(mapTgMember({ user: { id: 1 }, status: 'creator' }).is_admin).toBe(
      true,
    );
    expect(mapTgMember({ user: { id: 2 }, status: 'member' }).is_admin).toBe(
      false,
    );
  });

  test('adminMemberList marks the roster incomplete with a reason and total', () => {
    const list = adminMemberList(
      [{ user: { id: 1, first_name: 'A' }, status: 'creator' }],
      120,
    );
    expect(list.members).toHaveLength(1);
    expect(list.capability.supported).toBe(true);
    expect(list.capability.complete).toBe(false);
    expect(list.capability.total).toBe(120);
    expect(list.capability.reason).toContain('Bot API');
  });

  test('inaccessibleMemberList is unsupported with the raw reason', () => {
    const list = inaccessibleMemberList('no admins in private chat');
    expect(list.members).toEqual([]);
    expect(list.capability).toEqual({
      supported: false,
      complete: false,
      reason: 'no admins in private chat',
    });
  });
});
