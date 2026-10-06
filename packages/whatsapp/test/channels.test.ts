import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEventBuffer, type GroupMetadata } from 'baileys';
import { DIRECTORY_LIMIT } from '@metro-labs/core/stations/channel-directory';
import { KnownChats, channelFiles } from '../src/channel-chats.js';
import { WhatsAppChannels } from '../src/channels.js';
import { baileysLogger } from '../src/logger.js';
import { whatsappStation } from '../src/station.js';

const DIRECT = '447700900001@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';
const group = (id = GROUP, subject = 'Quiet group'): GroupMetadata => ({ id, subject, owner: undefined, participants: [] });
const remote = (...groups: GroupMetadata[]) => ({ groupFetchAllParticipating: () => Promise.resolve(Object.fromEntries(groups.map((value) => [value.id, value]))) });
let dir: string;
let previous: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-wa-channels-'));
  previous = process.env.WHATSAPP_TOKEN_DIR;
  process.env.WHATSAPP_TOKEN_DIR = dir;
});
afterEach(() => {
  if (previous === undefined) delete process.env.WHATSAPP_TOKEN_DIR;
  else process.env.WHATSAPP_TOKEN_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

describe('WhatsApp channel metadata', () => {
  test('remote groups need no recent message or local roster and removed groups disappear', async () => {
    const channels = new WhatsAppChannels('fixture');
    expect(await channels.list(remote(group()), {})).toEqual({
      channels: [{ id: GROUP, line: `metro://whatsapp/fixture/${GROUP}`, kind: 'group', name: 'Quiet group' }],
      capability: { supported: true, complete: false, source: 'mixed', reason: expect.stringContaining('no all-direct-chats directory') },
    });
    expect((await channels.list(remote(), {})).channels).toEqual([]);
    expect(existsSync(channelFiles.path('fixture'))).toBe(false);
  });

  test('chat metadata survives restart without retaining other fields or inventing contact chats', async () => {
    const ev = makeEventBuffer(baileysLogger('channels-fixture'));
    const channels = new WhatsAppChannels('fixture');
    channels.bind({ ev }, () => true);
    ev.emit('contacts.upsert', [{ id: '777@lid', name: 'Not a conversation' }]);
    ev.emit('messaging-history.set', { chats: [{ id: DIRECT, name: 'Saved direct', unreadCount: 17 }], contacts: [], messages: [] });
    ev.emit('chats.update', [{ id: DIRECT, name: 'Renamed direct' }]);
    ev.emit('chats.upsert', [{ id: 'status@broadcast', name: 'Status' }, { id: GROUP, name: 'Not authoritative' }]);
    const file = channelFiles.path('fixture');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([{ id: DIRECT, name: 'Renamed direct' }]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const restored = new WhatsAppChannels('fixture');
    expect((await restored.list(remote(), {})).channels).toEqual([
      { id: DIRECT, name: 'Renamed direct', kind: 'direct', line: `metro://whatsapp/fixture/${DIRECT}` },
    ]);
    expect((await new WhatsAppChannels('other').list(remote(), {})).channels).toEqual([]);
  });

  test('delete and clear cleanup survive restart and reject older history metadata', async () => {
    const ev = makeEventBuffer(baileysLogger('channels-fixture'));
    let current = true;
    const channels = new WhatsAppChannels('fixture');
    channels.bind({ ev }, () => current);
    ev.emit('chats.upsert', [{ id: DIRECT, name: 'Direct' }, { id: '777@lid', name: 'Other' }]);
    ev.emit('chats.delete', [DIRECT]);
    ev.emit('chats.clear', { id: '777@lid' });
    ev.emit('messaging-history.set', { chats: [{ id: DIRECT, name: 'Old name' }, { id: '777@lid' }], contacts: [], messages: [] });
    expect((await channels.list(remote(), {})).channels).toEqual([]);
    const restored = new WhatsAppChannels('fixture');
    expect((await restored.list(remote(), {})).channels).toEqual([]);
    ev.emit('chats.upsert', [{ id: DIRECT, name: 'New chat' }]);
    expect((await channels.list(remote(), {})).channels[0]?.name).toBe('New chat');
    current = false;
    ev.emit('chats.delete', [DIRECT]);
    ev.emit('chats.upsert', [{ id: '888@lid' }]);
    expect((await channels.list(remote(), {})).channels.map((entry) => entry.id)).toEqual([DIRECT]);
  });

  test('query and opaque paging preserve partial coverage and do not refetch groups', async () => {
    let calls = 0;
    const source = { groupFetchAllParticipating: () => { calls++; return Promise.resolve({ b: group('2@g.us', 'TEAM second'), a: group('1@g.us', 'Team first') }); } };
    const channels = new WhatsAppChannels('fixture');
    const first = await channels.list(source, { limit: 1, query: 'team' });
    expect(first.channels.map((entry) => entry.id)).toEqual(['1@g.us']);
    expect(first.next_cursor).toBeString();
    const second = await channels.list(source, { limit: 1, query: 'team', cursor: first.next_cursor });
    expect(second.channels.map((entry) => entry.id)).toEqual(['2@g.us']);
    expect(second.capability.complete).toBe(false);
    expect(second.next_cursor).toBeUndefined();
    expect(calls).toBe(1);
    await expect(channels.list(source, { cursor: first.next_cursor, query: 'other' })).rejects.toThrow('cursor');
    await expect(new WhatsAppChannels('other').list(source, { cursor: first.next_cursor, query: 'team' })).rejects.toThrow('cursor');
    expect((await channels.list(source, { query: '2@g.us' })).channels.map((entry) => entry.id)).toEqual(['2@g.us']);
    await expect(channels.list(source, { limit: 101 })).rejects.toThrow('limit');
    await expect(channels.list(source, { query: 'x'.repeat(201) })).rejects.toThrow('query');
  });

  test('metadata storage is bounded and cleanup stays account-local', () => {
    const chats = new KnownChats('fixture');
    chats.note(Array.from({ length: DIRECTORY_LIMIT + 1 }, (_, i) => ({ id: `${i + 1}@lid`, name: 'x'.repeat(400) })));
    expect(chats.list()).toHaveLength(DIRECTORY_LIMIT);
    expect(chats.list()[0]?.id).toBe('2@lid');
    expect(chats.list()[0]?.name).toHaveLength(256);
    expect(new KnownChats('fixture').list()).toHaveLength(DIRECTORY_LIMIT);
    new KnownChats('kept').note([{ id: DIRECT }]);
    whatsappStation.forget?.('fixture');
    expect(existsSync(channelFiles.path('fixture'))).toBe(false);
    expect(existsSync(channelFiles.path('kept'))).toBe(true);
    new KnownChats('orphan').note([{ id: DIRECT }]);
    whatsappStation.forgetExcept?.(['kept']);
    expect(existsSync(channelFiles.path('orphan'))).toBe(false);
    expect(existsSync(channelFiles.path('kept'))).toBe(true);
  });

  test('remote listing failures surface without a false empty or complete directory', async () => {
    const channels = new WhatsAppChannels('fixture');
    await expect(channels.list({ groupFetchAllParticipating: () => Promise.reject(new Error('fixture remote unavailable')) }, {})).rejects.toThrow('fixture remote unavailable');
  });
});
