import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { handleCall } from '../src/actions.ts';
import { accounts, bootAccount } from '../src/accounts.ts';
import { bytesToHex, callbackMac, open, seal } from '../src/crypto.ts';
import { GroupStore, parseGroupKey } from '../src/groups.ts';
import {
  decode,
  decodeReactionProto,
  encodeGroupReaction,
  encodeGroupText,
  encodeReaction,
  encodeReactionProto,
  MSG_GROUP_DELIVERY_RECEIPT,
  MSG_GROUP_LEAVE,
  MSG_GROUP_REACTION,
  MSG_GROUP_RENAME,
  MSG_GROUP_REQUEST_SYNC,
  MSG_GROUP_SETUP,
  MSG_GROUP_TEXT,
  MSG_REACTION,
  RECEIPT_ACK,
} from '../src/messages.ts';

const GROUP = { creator: 'ALICE001', groupId: '0011223344556677' };
const GROUP_LINE = 'metro://threema/t0/ALICE001-0011223344556677';

describe('the message layouts', () => {
  test('a group text carries the creator, the group id and the text, and reads back', () => {
    const bytes = encodeGroupText(GROUP, 'hi all');
    expect(bytes[0]).toBe(MSG_GROUP_TEXT);
    expect(Buffer.from(bytes.subarray(1, 9)).toString('ascii')).toBe('ALICE001');
    expect(bytesToHex(bytes.subarray(9, 17))).toBe('0011223344556677');
    expect(decode(bytes)).toEqual({ kind: 'group-text', group: GROUP, text: 'hi all' });
  });

  test('setup, rename, leave, group receipt and sync request', () => {
    const setup = new Uint8Array([MSG_GROUP_SETUP, ...Buffer.from('0011223344556677', 'hex'), ...Buffer.from('BOB00002CAROL003', 'ascii')]);
    expect(decode(setup)).toEqual({ kind: 'group-setup', groupId: '0011223344556677', members: ['BOB00002', 'CAROL003'] });
    const rename = new Uint8Array([MSG_GROUP_RENAME, ...Buffer.from('0011223344556677', 'hex'), ...Buffer.from('Ops team', 'utf8')]);
    expect(decode(rename)).toEqual({ kind: 'group-rename', groupId: '0011223344556677', name: 'Ops team' });
    const leave = new Uint8Array([MSG_GROUP_LEAVE, ...Buffer.from('ALICE001', 'ascii'), ...Buffer.from('0011223344556677', 'hex')]);
    expect(decode(leave)).toEqual({ kind: 'group-leave', group: GROUP });
    const receipt = new Uint8Array([MSG_GROUP_DELIVERY_RECEIPT, ...Buffer.from('ALICE001', 'ascii'), ...Buffer.from('0011223344556677', 'hex'), RECEIPT_ACK, ...Buffer.from('0123456789abcdef', 'hex')]);
    expect(decode(receipt)).toEqual({ kind: 'receipt', group: GROUP, status: RECEIPT_ACK, messageIds: ['0123456789abcdef'] });
    expect(decode(new Uint8Array([MSG_GROUP_SETUP, 1, 2]))).toEqual({ kind: 'other', type: MSG_GROUP_SETUP });
    expect(MSG_GROUP_REQUEST_SYNC).toBe(0x51);
  });

  test('a reaction is a protobuf Reaction: the raw message id as fixed64, the emoji as apply or withdraw', () => {
    const apply = encodeReactionProto('0123456789abcdef', '👍', false);
    expect(bytesToHex(apply)).toBe(`09${'0123456789abcdef'}12${'04'}${Buffer.from('👍').toString('hex')}`);
    expect(decodeReactionProto(apply)).toEqual({ messageId: '0123456789abcdef', emoji: '👍', removed: false });
    const withdraw = encodeReactionProto('0123456789abcdef', '❤️', true);
    expect(withdraw[9]).toBe(0x1a);
    expect(decodeReactionProto(withdraw)).toEqual({ messageId: '0123456789abcdef', emoji: '❤️', removed: true });
    expect(decode(encodeReaction('0123456789abcdef', '🎉', false))).toEqual({ kind: 'reaction', group: null, messageId: '0123456789abcdef', emoji: '🎉', removed: false });
    const grouped = encodeGroupReaction(GROUP, '0123456789abcdef', '🎉', true);
    expect(grouped[0]).toBe(MSG_GROUP_REACTION);
    expect(decode(grouped)).toEqual({ kind: 'reaction', group: GROUP, messageId: '0123456789abcdef', emoji: '🎉', removed: true });
    expect(decodeReactionProto(new Uint8Array([0x09, 1, 2]))).toBeNull();
    expect(decode(new Uint8Array([MSG_REACTION, 0x12, 0x00]))).toEqual({ kind: 'other', type: MSG_REACTION });
  });
});

describe('the group roster', () => {
  test('is filled by the creator, renamed, thinned by leaves, and survives a restart on disk', () => {
    process.env.THREEMA_GROUPS_DIR = mkdtempSync(join(tmpdir(), 'threema-groups-'));
    const store = new GroupStore('t0', '*METRO01');
    expect(store.get(GROUP)).toBeUndefined();
    expect(store.recipients(GROUP)).toBeNull();
    store.setup('ALICE001', '0011223344556677', ['BOB00002', '*METRO01']);
    expect(store.recipients(GROUP)).toEqual(['ALICE001', 'BOB00002']);
    store.rename('ALICE001', '0011223344556677', 'Ops team');
    store.leave(GROUP, 'BOB00002');
    const again = new GroupStore('t0', '*METRO01');
    expect(again.get(GROUP)).toEqual({ creator: 'ALICE001', groupId: '0011223344556677', members: ['ALICE001', '*METRO01'], name: 'Ops team' });
    again.leave(GROUP, '*METRO01');
    expect(new GroupStore('t0', '*METRO01').get(GROUP)).toBeUndefined();
    expect(parseGroupKey('alice001-0011223344556677')).toEqual(GROUP);
    expect(parseGroupKey('ECHOECHO')).toBeNull();
  });
});

const gateway = nacl.box.keyPair();
const alice = nacl.box.keyPair();
const SECRET = 's3cret';

interface Written {
  responses: Record<string, unknown>[];
  events: Record<string, unknown>[];
}

function capture(): { written: Written; restore: () => void } {
  const written: Written = { responses: [], events: [] };
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    for (const line of String(chunk).split('\n')) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.op === 'response') written.responses.push(parsed);
      else if (parsed.op !== 'log') written.events.push(parsed);
    }
    return true;
  }) as typeof process.stdout.write;
  return { written, restore: () => void (process.stdout.write = orig) };
}

let sends: URLSearchParams[];
let realFetch: typeof fetch;
let cap: ReturnType<typeof capture>;
let sentCounter = 0;

const call = (action: string, args: Record<string, unknown>): Promise<void> => handleCall({ op: 'call', id: 'c1', action, args });

const inboundFrom = (from: string, plain: Uint8Array, messageId = 'aaaaaaaaaaaaaaaa'): Record<string, unknown> => {
  const { nonce, box } = seal(plain, gateway.publicKey, { publicKey: alice.publicKey, secretKey: alice.secretKey });
  const fields = { from, to: '*METRO01', messageId, date: '1700000000', nonce: bytesToHex(nonce), box: bytesToHex(box) };
  return { account: 't0', ...fields, mac: callbackMac(SECRET, fields), nickname: 'Alice' };
};

const openedTo = (form: URLSearchParams): ReturnType<typeof decode> =>
  decode(open(new Uint8Array(Buffer.from(form.get('box') ?? '', 'hex')), new Uint8Array(Buffer.from(form.get('nonce') ?? '', 'hex')), gateway.publicKey, alice) ?? new Uint8Array());

beforeEach(() => {
  process.env.THREEMA_GROUPS_DIR = mkdtempSync(join(tmpdir(), 'threema-groups-'));
  sends = [];
  sentCounter = 0;
  accounts.set('t0', bootAccount({ id: 't0', gatewayId: '*METRO01', secret: SECRET, privateKey: bytesToHex(gateway.secretKey) }));
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/pubkeys/')) return Promise.resolve(new Response(bytesToHex(alice.publicKey)));
    if (url.endsWith('/send_e2e')) {
      sends.push(new URLSearchParams(String(init?.body)));
      sentCounter += 1;
      return Promise.resolve(new Response(`000000000000000${String(sentCounter)}`));
    }
    return Promise.resolve(new Response('', { status: 500 }));
  }) as typeof fetch;
  cap = capture();
});

afterEach(() => {
  cap.restore();
  globalThis.fetch = realFetch;
  accounts.clear();
});

describe('groups on the wire', () => {
  test('a group text lands on the group line, asks the creator for the roster once, and a setup fills it', async () => {
    await call('callback', inboundFrom('ALICE001', encodeGroupText(GROUP, 'hello @@*METRO01')));
    expect(cap.written.responses[0]).toMatchObject({ result: { ok: true, kind: 'group-text' } });
    expect(cap.written.events[0]).toMatchObject({ line: GROUP_LINE, line_name: 'ALICE001-0011223344556677', is_private: false, mentions_self: true, text: 'hello @@*METRO01', from: 'metro://threema/t0/user/ALICE001' });
    await new Promise((r) => setTimeout(r, 10));
    expect(sends).toHaveLength(1);
    expect(sends[0]?.get('to')).toBe('ALICE001');
    expect(sends[0]?.get('group')).toBe('1');
    expect(openedTo(sends[0] ?? new URLSearchParams())).toEqual({ kind: 'other', type: MSG_GROUP_REQUEST_SYNC });
    await call('callback', inboundFrom('ALICE001', encodeGroupText(GROUP, 'again')));
    await new Promise((r) => setTimeout(r, 10));
    expect(sends).toHaveLength(1);
    const setup = new Uint8Array([MSG_GROUP_SETUP, ...Buffer.from('0011223344556677', 'hex'), ...Buffer.from('BOB00002*METRO01', 'ascii')]);
    await call('callback', inboundFrom('ALICE001', setup));
    const rename = new Uint8Array([MSG_GROUP_RENAME, ...Buffer.from('0011223344556677', 'hex'), ...Buffer.from('Ops', 'utf8')]);
    await call('callback', inboundFrom('ALICE001', rename));
    cap.written.responses.length = 0;
    await call('listMembers', { line: GROUP_LINE });
    expect(cap.written.responses[0]).toMatchObject({ result: { members: [{ id: 'ALICE001', is_admin: true }, { id: 'BOB00002' }, { id: '*METRO01', is_bot: true }], capability: { supported: true, complete: true, total: 3 } } });
    cap.written.events.length = 0;
    await call('callback', inboundFrom('ALICE001', encodeGroupText(GROUP, 'named now')));
    expect(cap.written.events[0]).toMatchObject({ line_name: 'Ops' });
  });

  test('a send to a group goes to every member but us with the group flag, and a reply is a quote', async () => {
    await call('callback', inboundFrom('ALICE001', new Uint8Array([MSG_GROUP_SETUP, ...Buffer.from('0011223344556677', 'hex'), ...Buffer.from('BOB00002*METRO01', 'ascii')])));
    sends.length = 0;
    cap.written.responses.length = 0;
    await call('reply', { line: GROUP_LINE, text: 'on it', replyTo: '0123456789abcdef' });
    expect(sends.map((s) => s.get('to'))).toEqual(['ALICE001', 'BOB00002']);
    expect(sends.every((s) => s.get('group') === '1')).toBe(true);
    expect(openedTo(sends[0] ?? new URLSearchParams())).toEqual({ kind: 'group-text', group: GROUP, text: '> quote #0123456789abcdef\n\non it' });
    expect(cap.written.responses[0]).toMatchObject({ result: { messageId: '0000000000000001', messageIds: ['0000000000000001', '0000000000000002'], account: 't0' } });
    cap.written.responses.length = 0;
    await call('send', { line: 'metro://threema/t0/CAROL003-0011223344556677', text: 'who?' });
    expect(cap.written.responses[0]).toMatchObject({ errorInfo: { code: 'threema_unknown_group' } });
  });

  test('react and unreact seal a Reaction for a contact or for every group member, and an inbound reaction is an event', async () => {
    await call('react', { line: 'metro://threema/t0/ALICE001', messageId: '0123456789ABCDEF', emoji: '👍' });
    expect(sends).toHaveLength(1);
    expect(sends[0]?.get('group')).toBeNull();
    expect(openedTo(sends[0] ?? new URLSearchParams())).toEqual({ kind: 'reaction', group: null, messageId: '0123456789abcdef', emoji: '👍', removed: false });
    expect(cap.written.events[0]).toMatchObject({ text: '[react 👍]', event: { type: 'react', emoji: '👍', targetId: '0123456789abcdef' } });
    await call('callback', inboundFrom('ALICE001', new Uint8Array([MSG_GROUP_SETUP, ...Buffer.from('0011223344556677', 'hex'), ...Buffer.from('BOB00002', 'ascii')])));
    sends.length = 0;
    await call('unreact', { line: GROUP_LINE, messageId: '0123456789abcdef', emoji: '👍' });
    expect(sends.map((s) => s.get('to'))).toEqual(['ALICE001', 'BOB00002']);
    expect(openedTo(sends[1] ?? new URLSearchParams())).toEqual({ kind: 'reaction', group: GROUP, messageId: '0123456789abcdef', emoji: '👍', removed: true });
    cap.written.events.length = 0;
    await call('callback', inboundFrom('ALICE001', encodeGroupReaction(GROUP, 'fedcba9876543210', '🎉', false)));
    expect(cap.written.events[0]).toMatchObject({ line: GROUP_LINE, is_private: false, emoji: '🎉', text: '[react 🎉]', event: { type: 'react', emoji: '🎉', targetId: 'fedcba9876543210' } });
    await call('callback', inboundFrom('ALICE001', encodeReaction('fedcba9876543210', '🎉', true)));
    expect(cap.written.events[1]).toMatchObject({ line: 'metro://threema/t0/ALICE001', is_private: true, text: '[react 🎉 (removed)]', event: { type: 'react', emoji: '🎉', removed: true } });
    cap.written.responses.length = 0;
    await call('react', { line: 'metro://threema/t0/ALICE001', messageId: 'nope', emoji: '👍' });
    expect(cap.written.responses[0]).toMatchObject({ errorInfo: { code: 'threema_bad_message_id' } });
  });
});
