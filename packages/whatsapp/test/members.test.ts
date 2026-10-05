import { describe, expect, test } from 'bun:test';
import type { GroupMetadata } from 'baileys';
import { listMembers } from '../src/members.ts';
import { makeNameBook } from '../src/names.ts';

const JID = '123@g.us';
const GROUP: GroupMetadata = {
  id: JID,
  subject: 'Fixture group',
  size: 3,
  participants: [
    { id: '123@lid', phoneNumber: '447700900111@s.whatsapp.net', admin: 'superadmin' },
    { id: '447700900222@s.whatsapp.net', lid: '456@lid', admin: 'admin' },
    { id: '789@lid', admin: null },
  ],
};

function lookup(group: GroupMetadata = GROUP): (jid: string) => Promise<GroupMetadata> {
  return (jid) => {
    expect(jid).toBe(JID);
    return Promise.resolve(group);
  };
}

describe('WhatsApp group members', () => {
  test('preserves network identities and admin roles without guessing phone numbers', async () => {
    const names = makeNameBook();
    names.note('456@lid', 'Second member');
    const result = await listMembers(JID, lookup(), names);
    expect(result).toEqual({
      members: [
        { id: '123@lid', lid: '123@lid', phoneNumber: '447700900111@s.whatsapp.net', address: '+447700900111', roles: ['superadmin'], is_admin: true },
        { id: '447700900222@s.whatsapp.net', lid: '456@lid', phoneNumber: '447700900222@s.whatsapp.net', address: '+447700900222', display_name: 'Second member', roles: ['admin'], is_admin: true },
        { id: '789@lid', lid: '789@lid', roles: [], is_admin: false },
      ],
      capability: { supported: true, complete: true, total: 3 },
    });
  });

  test('reports the full total but not completeness after limiting', async () => {
    const result = await listMembers(JID, lookup(), makeNameBook(), 1);
    expect(result.members).toHaveLength(1);
    expect(result.capability).toMatchObject({ supported: true, complete: false, total: 3, reason: expect.stringContaining('limited') });
  });

  test('does not assume a server response is complete', async () => {
    const result = await listMembers(JID, lookup({ ...GROUP, size: 8 }), makeNameBook());
    expect(result.capability).toMatchObject({ complete: false, total: 8, reason: expect.stringContaining('partial') });
    const withoutSize = { ...GROUP };
    delete withoutSize.size;
    const unknown = await listMembers(JID, lookup(withoutSize), makeNameBook());
    expect(unknown.capability).toMatchObject({ complete: false, reason: expect.stringContaining('total') });
    expect(unknown.capability.total).toBeUndefined();
  });

  test('deduplicates only identical member ids, not aliases', async () => {
    const result = await listMembers(JID, lookup({ ...GROUP, participants: [...GROUP.participants, GROUP.participants[0]!] }), makeNameBook());
    expect(result.members).toHaveLength(3);
    const aliases = await listMembers(JID, lookup({ ...GROUP, size: 2, participants: [GROUP.participants[0]!, { id: '447700900111@s.whatsapp.net', lid: '123@lid' }] }), makeNameBook());
    expect(aliases.members).toHaveLength(2);
  });

  test('non-groups are unsupported without a metadata request', async () => {
    const result = await listMembers('123@lid', () => Promise.reject(new Error('must not fetch')), makeNameBook());
    expect(result.capability).toMatchObject({ supported: false, complete: false });
  });

  test('surfaces upstream refusal instead of disguising it as unsupported', async () => {
    await expect(listMembers(JID, () => Promise.reject(new Error('403 forbidden')), makeNameBook())).rejects.toThrow('403 forbidden');
  });

  test('validates and bounds limits before querying', async () => {
    for (const invalid of [0, -1, 0.5, NaN, Infinity]) {
      await expect(listMembers(JID, () => Promise.reject(new Error('must not fetch')), makeNameBook(), invalid)).rejects.toThrow('positive integer');
    }
    const participants = Array.from({ length: 1100 }, (_, i) => ({ id: `${i}@lid` }));
    const result = await listMembers(JID, lookup({ ...GROUP, size: 1100, participants }), makeNameBook(), 9000);
    expect(result.members).toHaveLength(1000);
    expect(result.capability.complete).toBe(false);
  });
});
