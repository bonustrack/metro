import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEventBuffer } from 'baileys';
import type { WAClient } from '../src/client-types.js';
import { KnownChats, channelFiles } from '../src/channel-chats.js';
import { WhatsAppChannels } from '../src/channels.js';
import { baileysLogger } from '../src/logger.js';
import { fixture, fixtureRuntime } from './client-fixture.js';

const DIRECT = '789@lid';
const START = 1_790_000_000_000;
const clients: WAClient[] = [];
let dir: string;
let previous: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-wa-channel-regressions-'));
  previous = process.env.WHATSAPP_TOKEN_DIR;
  process.env.WHATSAPP_TOKEN_DIR = dir;
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.disconnect();
  if (previous === undefined) delete process.env.WHATSAPP_TOKEN_DIR;
  else process.env.WHATSAPP_TOKEN_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

const remote = () => Promise.resolve({ groupFetchAllParticipating: () => Promise.resolve({}) });

for (const deletion of ['clear', 'delete']) {
  test(`${deletion}: a newer ordinary chat update restores metadata after restart, not stale sync or title updates`, async () => {
    let now = START;
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const ev = makeEventBuffer(baileysLogger('channels-fixture'));
      const channels = new WhatsAppChannels('fixture');
      channels.bind({ ev }, () => true);
      ev.emit('chats.upsert', [{ id: DIRECT, name: 'Old chat', conversationTimestamp: START / 1000 - 1 }]);
      if (deletion === 'clear') ev.emit('chats.clear', { id: DIRECT });
      else ev.emit('chats.delete', [DIRECT]);
      const restarted = new WhatsAppChannels('fixture');
      const fresh = makeEventBuffer(baileysLogger('channels-restarted'));
      restarted.bind({ ev: fresh }, () => true);
      now += 2000;
      fresh.emit('chats.update', [{ id: DIRECT, name: 'Title-only update' }]);
      fresh.emit('chats.update', [{ id: DIRECT, conversationTimestamp: START / 1000 - 1, unreadCount: 1 }]);
      fresh.emit('chats.upsert', [{ id: DIRECT, name: 'Old upsert', conversationTimestamp: START / 1000 - 1 }]);
      fresh.emit('chats.update', [{ id: DIRECT, conversationTimestamp: (now + 1000) / 1000 }]);
      fresh.emit('chats.update', [{ id: DIRECT, conversationTimestamp: START / 1000 }]);
      fresh.emit('messaging-history.set', {
        chats: [{ id: DIRECT, name: 'Synced chat', conversationTimestamp: now / 1000 }], contacts: [], messages: [],
      });
      expect((await restarted.list(remote, {})).channels).toEqual([]);
      fresh.emit('chats.update', [{ id: DIRECT, conversationTimestamp: now / 1000, unreadCount: 1 }]);
      expect((await restarted.list(remote, {})).channels.map((entry) => entry.id)).toEqual([DIRECT]);
      expect((await new WhatsAppChannels('fixture').list(remote, {})).channels.map((entry) => entry.id)).toEqual([DIRECT]);
      expect(JSON.parse(readFileSync(channelFiles.path('fixture'), 'utf8'))).toEqual([{ id: DIRECT }]);
      now += 2000;
      fresh.emit('chats.delete', [DIRECT]);
      fresh.emit('chats.update', [{ id: DIRECT, conversationTimestamp: (now - 2000) / 1000 }]);
      expect((await new WhatsAppChannels('fixture').list(remote, {})).channels).toEqual([]);
    } finally {
      clock.mockRestore();
    }
  });
}

test('legacy markers use load time, and repeated deletion advances the persisted cutoff', () => {
  let now = START;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  try {
    writeFileSync(channelFiles.path('fixture'), JSON.stringify([{ id: DIRECT, deleted: true }]));
    const chats = new KnownChats('fixture');
    now += 2000;
    for (const conversationTimestamp of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, START / 1000, now / 1000 + 0.5])
      chats.note([{ id: DIRECT, conversationTimestamp }], true);
    expect(chats.list()).toEqual([]);
    chats.note([{ id: DIRECT, conversationTimestamp: { toNumber: () => now / 1000 } }], true);
    expect(chats.list().map((entry) => entry.id)).toEqual([DIRECT]);
    chats.remove([DIRECT]);
    now += 2000;
    chats.remove([DIRECT]);
    expect(JSON.parse(readFileSync(channelFiles.path('fixture'), 'utf8'))).toEqual([{ id: DIRECT, deleted: true, deletedAt: now }]);
    const restarted = new KnownChats('fixture');
    now += 2000;
    restarted.note([{ id: DIRECT, conversationTimestamp: (now - 3000) / 1000 }], true);
    expect(restarted.list()).toEqual([]);
    restarted.note([{ id: DIRECT, conversationTimestamp: now / 1000 }], true);
    expect(new KnownChats('fixture').list().map((entry) => entry.id)).toEqual([DIRECT]);
  } finally {
    clock.mockRestore();
  }
});

async function reconnecting() {
  const f = await fixture(clients);
  f.sock.groupFetchAllParticipating = () => Promise.resolve({
    first: { id: '1@g.us', subject: 'First', owner: undefined, participants: [] },
    second: { id: '2@g.us', subject: 'Second', owner: undefined, participants: [] },
  });
  const first = await f.client.listChannels({ limit: 1 });
  const next = fixtureRuntime();
  let calls = 0;
  next.sock.groupFetchAllParticipating = () => { calls++; return Promise.resolve({}); };
  f.runtime.makeSocket = () => next.sock;
  f.ev.emit('connection.update', { connection: 'close' });
  await Bun.sleep(0);
  return { ...f, cursor: first.next_cursor, next, calls: () => calls };
}

function promptly<T>(operation: Promise<T>): Promise<T | 'timed out'> {
  return Promise.race([operation, Bun.sleep(100).then(() => 'timed out' as const)]);
}

test('an unexpired cached page is returned during reconnection without waiting or querying a socket', async () => {
  const f = await reconnecting();
  try {
    const page = await promptly(f.client.listChannels({ cursor: f.cursor }));
    expect(page).not.toBe('timed out');
    if (page === 'timed out') throw new Error('cached page waited for the connection');
    expect(page.channels.map((entry) => entry.id)).toEqual(['2@g.us']);
    expect(f.calls()).toBe(0);
  } finally {
    f.next.ev.emit('connection.update', { connection: 'open' });
  }
});

test('invalid and expired cursors fail before socket readiness during reconnection', async () => {
  const clock = spyOn(Date, 'now').mockReturnValue(START);
  const f = await reconnecting();
  clock.mockReturnValue(START + 5 * 60 * 1000 + 1);
  try {
    for (const cursor of ['invalid-cursor', f.cursor]) {
      const result = await promptly(f.client.listChannels({ cursor }).then(() => 'accepted', (err: unknown) => err));
      expect(result).toBeInstanceOf(Error);
      if (result instanceof Error) expect(result.message).toContain('cursor');
    }
    expect(f.calls()).toBe(0);
  } finally {
    clock.mockRestore();
    f.next.ev.emit('connection.update', { connection: 'open' });
  }
});

test('a fresh snapshot waits for the current socket, while a closed client rejects cached pages', async () => {
  const f = await reconnecting();
  const load = f.client.listChannels({});
  expect(await promptly(load)).toBe('timed out');
  expect(f.calls()).toBe(0);
  f.next.ev.emit('connection.update', { connection: 'open' });
  expect((await load).channels).toEqual([]);
  expect(f.calls()).toBe(1);
  await f.client.disconnect();
  await expect(f.client.listChannels({ cursor: f.cursor })).rejects.toThrow('socket not connected');
});
