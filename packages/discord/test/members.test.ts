import { describe, expect, test } from 'bun:test';
import {
  indexRoles,
  mapGuildMember,
  mapGuildMembers,
  mapRecipients,
} from '../src/members.ts';

const ADMIN = String(1n << 3n);

describe('discord member mapping', () => {
  test('indexRoles flags the ADMINISTRATOR bit', () => {
    const idx = indexRoles([
      { id: 'r1', name: 'Admin', permissions: ADMIN },
      { id: 'r2', name: 'Member', permissions: '0' },
    ]);
    expect(idx.get('r1')).toEqual({ name: 'Admin', admin: true });
    expect(idx.get('r2')).toEqual({ name: 'Member', admin: false });
  });

  test('maps a guild member with nick, roles, bot and admin', () => {
    const roles = indexRoles([
      { id: 'r1', name: 'Admin', permissions: ADMIN },
      { id: 'r2', name: 'Mod', permissions: '0' },
    ]);
    const m = mapGuildMember(
      {
        user: { id: '42', username: 'less', global_name: 'Less', bot: false },
        nick: 'lessnick',
        roles: ['r1', 'r2'],
      },
      roles,
    );
    expect(m).toEqual({
      id: '42',
      name: 'less',
      display_name: 'lessnick',
      roles: ['Admin', 'Mod'],
      is_admin: true,
      is_bot: false,
    });
  });

  test('falls back to global_name when no nick and marks owner admin', () => {
    const roles = indexRoles([]);
    const m = mapGuildMember(
      { user: { id: '7', username: 'owner', global_name: 'Owner' }, roles: [] },
      roles,
      '7',
    );
    expect(m?.display_name).toBe('Owner');
    expect(m?.is_admin).toBe(true);
  });

  test('drops entries without a user id', () => {
    expect(mapGuildMembers([{ nick: 'ghost' }], new Map())).toEqual([]);
  });

  test('mapRecipients shapes DM participants', () => {
    expect(
      mapRecipients([{ id: '1', username: 'a', global_name: 'A', bot: true }]),
    ).toEqual([{ id: '1', name: 'a', display_name: 'A', is_bot: true }]);
  });
});
