import { describe, expect, test } from 'bun:test';
import type { BinaryNode } from 'baileys';
import { extractGroupMetadata } from 'baileys/lib/Socket/groups.js';
import { listMembers } from '../src/members.js';
import { makeNameBook } from '../src/names.js';

const JID = '123@g.us';
const PARTICIPANTS: BinaryNode[] = [
  { tag: 'participant', attrs: { jid: '123@lid', phone_number: '447700900111@s.whatsapp.net', type: 'superadmin' } },
  { tag: 'participant', attrs: { jid: '447700900222@s.whatsapp.net', lid: '456@lid', type: 'admin' } },
  { tag: 'participant', attrs: { jid: '789@lid' } },
];

function response(size?: string, participants = PARTICIPANTS): BinaryNode {
  return {
    tag: 'iq', attrs: { type: 'result' },
    content: [{ tag: 'group', attrs: { id: JID, subject: 'Fixture group', ...(size === undefined ? {} : { size }) }, content: participants }],
  };
}

function lookup(group = response('3')): (query: BinaryNode) => Promise<BinaryNode> {
  return (query) => {
    expect(query).toEqual({ tag: 'iq', attrs: { type: 'get', xmlns: 'w:g2', to: JID }, content: [{ tag: 'query', attrs: { request: 'interactive' } }] });
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

  test('does not promote the pinned SDK synthesized size to an authoritative total', async () => {
    const raw = response();
    const metadata = extractGroupMetadata(raw);
    expect(metadata.size).toBe(metadata.participants.length);
    expect(metadata.size).toBe(3);
    const result = await listMembers(JID, lookup(raw), makeNameBook());
    expect(result.members).toHaveLength(3);
    expect(result.capability).toMatchObject({ complete: false, reason: expect.stringContaining('total') });
    expect(result.capability.total).toBeUndefined();
  });

  test('preserves partial, empty and invalid raw server totals honestly', async () => {
    const result = await listMembers(JID, lookup(response('8')), makeNameBook());
    expect(result.capability).toMatchObject({ complete: false, total: 8, reason: expect.stringContaining('partial') });
    const empty = await listMembers(JID, lookup(response('0', [])), makeNameBook());
    expect(empty.capability).toEqual({ supported: true, complete: true, total: 0 });
    for (const size of ['', 'bad', '-1', '0.5', 'Infinity', '9007199254740992']) {
      const unknown = await listMembers(JID, lookup(response(size)), makeNameBook());
      expect(unknown.capability.complete).toBe(false);
      expect(unknown.capability.total).toBeUndefined();
    }
  });

  test('deduplicates only identical member ids, not aliases', async () => {
    const result = await listMembers(JID, lookup(response('3', [...PARTICIPANTS, PARTICIPANTS[0]!])), makeNameBook());
    expect(result.members).toHaveLength(3);
    const aliases = await listMembers(JID, lookup(response('2', [PARTICIPANTS[0]!, { tag: 'participant', attrs: { jid: '447700900111@s.whatsapp.net', lid: '123@lid' } }])), makeNameBook());
    expect(aliases.members).toHaveLength(2);
  });

  test('non-groups are unsupported without a metadata request', async () => {
    const result = await listMembers('123@lid', () => Promise.reject(new Error('must not fetch')), makeNameBook());
    expect(result.capability).toMatchObject({ supported: false, complete: false });
  });

  test('surfaces query and pinned extractor errors instead of disguising them as unsupported', async () => {
    await expect(listMembers(JID, () => Promise.reject(new Error('403 forbidden')), makeNameBook())).rejects.toThrow('403 forbidden');
    await expect(listMembers(JID, lookup({ tag: 'iq', attrs: {}, content: [{ tag: 'error', attrs: { code: '403', text: 'not a member' } }] }), makeNameBook())).rejects.toThrow('not a member');
    await expect(listMembers(JID, lookup({ tag: 'iq', attrs: {} }), makeNameBook())).rejects.toThrow('missing <group>');
    for (const raw of [null, 'bad', { tag: 'iq', attrs: { count: 1 } }, { tag: 'iq', attrs: {}, content: [null] }]) {
      await expect(listMembers(JID, () => Promise.resolve(raw), makeNameBook())).rejects.toThrow('invalid group metadata');
    }
  });

  test('validates and bounds limits before querying', async () => {
    for (const invalid of [0, -1, 0.5, NaN, Infinity]) {
      await expect(listMembers(JID, () => Promise.reject(new Error('must not fetch')), makeNameBook(), invalid)).rejects.toThrow('positive integer');
    }
    const participants = Array.from({ length: 1100 }, (_, i) => ({ tag: 'participant', attrs: { jid: `${i}@lid` } }));
    const result = await listMembers(JID, lookup(response('1100', participants)), makeNameBook(), 9000);
    expect(result.members).toHaveLength(1000);
    expect(result.capability.complete).toBe(false);
  });
});
