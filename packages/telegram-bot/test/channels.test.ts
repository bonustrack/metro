import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChannelList } from '@metro-labs/core/stations/channel-directory';
import { accounts } from '../src/accounts.ts';
import { handleCall } from '../src/actions.ts';
import { observeChannels, observedChatsFor } from '../src/channels.ts';
import { handleUpdate } from '../src/updates.ts';

interface Wire {
  op?: string;
  id?: string;
  result?: ChannelList;
  error?: string;
  line?: string;
  text?: string;
}

const originalFetch = globalThis.fetch;
const originalWrite = process.stdout.write;
const originalDir = process.env.TELEGRAM_BOT_STATE_DIR;
let dir: string;
let writes: Wire[];
let networkCalls: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'telegram-bot-list-channels-'));
  process.env.TELEGRAM_BOT_STATE_DIR = dir;
  writes = [];
  networkCalls = 0;
  for (const id of ['discovery-a', 'discovery-b'])
    accounts.set(id, { cfg: { id, token: '12345:fixture' }, api: 'https://telegram.invalid', fileApi: '', offset: 0 });
  globalThis.fetch = (async () => {
    networkCalls++;
    throw new Error('Discovery must not make network calls');
  }) as typeof fetch;
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    for (const line of String(chunk).split('\n'))
      if (line.trim()) writes.push(JSON.parse(line) as Wire);
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.stdout.write = originalWrite;
  for (const account of accounts.values()) observedChatsFor(account).flush();
  accounts.clear();
  if (originalDir === undefined) delete process.env.TELEGRAM_BOT_STATE_DIR;
  else process.env.TELEGRAM_BOT_STATE_DIR = originalDir;
  rmSync(dir, { recursive: true, force: true });
});

function note(account: string, id: number, name: string): void {
  observeChannels(account, {
    update_id: 1,
    message: { message_id: 2, date: 1, chat: { id, type: 'private', first_name: name }, text: 'Not directory metadata' },
  });
}

async function call(args: Record<string, unknown>): Promise<Wire> {
  const id = String(writes.length);
  await handleCall({ op: 'call', id, action: 'listChannels', args });
  const response = writes.find((entry) => entry.op === 'response' && entry.id === id);
  if (response === undefined) throw new Error('No train response');
  return response;
}

async function list(args: Record<string, unknown>): Promise<ChannelList> {
  const response = await call(args);
  if (response.result === undefined) throw new Error(response.error ?? 'No channel directory result');
  return response.result;
}

describe('telegram-bot channel discovery train action', () => {
  test('requires an explicit attached account, even when only one bot exists', async () => {
    accounts.delete('discovery-b');
    for (const args of [{}, { account: '' }, { account: 7 }, { line: 'metro://telegram-bot/discovery-a/42' }])
      expect((await call(args)).error).toContain('requires an explicit account');
    expect((await call({ account: 'unknown' })).error).toContain('unknown account');
    expect(networkCalls).toBe(0);
  });

  test('returns an honest empty local directory without a network lookup', async () => {
    const result = await list({ account: 'discovery-a' });
    expect(result.channels).toEqual([]);
    expect(result.capability).toMatchObject({ supported: true, complete: false, source: 'local' });
    expect(result.capability.reason).toContain('no all-chats API');
    expect(networkCalls).toBe(0);
  });

  test('uses shared metadata search and stable account-bound snapshot paging', async () => {
    note('discovery-a', 11, 'Project Alpha');
    note('discovery-a', 12, 'Project Beta');
    note('discovery-a', 13, 'Personal');
    note('discovery-b', 11, 'Other bot only');
    const first = await list({ account: 'discovery-a', query: ' PROJECT ', limit: 1 });
    expect(first.channels).toEqual([{ id: '11', kind: 'direct', name: 'Project Alpha', line: 'metro://telegram-bot/discovery-a/11' }]);
    expect(first.next_cursor).toBeString();
    expect(first.capability.complete).toBe(false);
    note('discovery-a', 14, 'Project Gamma');
    const second = await list({ account: 'discovery-a', query: 'project', limit: 1, cursor: first.next_cursor });
    expect(second.channels.map((entry) => entry.id)).toEqual(['12']);
    expect(second.next_cursor).toBeUndefined();
    expect(second.capability.complete).toBe(false);
    expect(second.capability.reason).toContain('no all-chats API');
    expect((await list({ account: 'discovery-a', query: 'project' })).channels).toHaveLength(3);
    expect((await list({ account: 'discovery-a', query: '/13' })).channels.map((entry) => entry.id)).toEqual(['13']);
    expect((await list({ account: 'discovery-b' })).channels).toEqual([
      { id: '11', kind: 'direct', name: 'Other bot only', line: 'metro://telegram-bot/discovery-b/11' },
    ]);
    expect(networkCalls).toBe(0);
  });

  test('replacing an account invalidates its previous directory cursors', async () => {
    note('discovery-a', 11, 'One');
    note('discovery-a', 12, 'Two');
    const first = await list({ account: 'discovery-a', limit: 1 });
    const previous = accounts.get('discovery-a');
    if (previous === undefined) throw new Error('Missing fixture account');
    observedChatsFor(previous).flush();
    accounts.delete('discovery-a');
    expect((await call({ account: 'discovery-a', cursor: first.next_cursor })).error).toContain('unknown account');
    accounts.set('discovery-a', { ...previous });
    expect((await call({ account: 'discovery-a', cursor: first.next_cursor })).error).toContain('Invalid or expired channel cursor');
    expect((await list({ account: 'discovery-a' })).channels).toHaveLength(2);
    expect(networkCalls).toBe(0);
  });

  test('shared cursor validation rejects different accounts, queries and invalid options', async () => {
    note('discovery-a', 11, 'One');
    note('discovery-a', 12, 'Two');
    const first = await list({ account: 'discovery-a', limit: 1 });
    for (const args of [
      { account: 'discovery-b', cursor: first.next_cursor },
      { account: 'discovery-a', cursor: first.next_cursor, query: 'changed' },
      { account: 'discovery-a', cursor: 'not-a-cursor' },
    ]) expect((await call(args)).error).toContain('Invalid or expired channel cursor');
    expect((await call({ account: 'discovery-a', limit: 101 })).error).toContain('limit');
    expect((await call({ account: 'discovery-a', query: 7 })).error).toContain('query');
    expect(networkCalls).toBe(0);
  });
});

describe('telegram-bot discovery preserves inbound delivery', () => {
  test('membership and channel-post metadata never emit messages or download media', async () => {
    handleUpdate('discovery-a', {
      update_id: 1,
      my_chat_member: { chat: { id: -1001, type: 'supergroup', title: 'Joined group' }, new_chat_member: { status: 'administrator' } },
    });
    handleUpdate('discovery-a', {
      update_id: 2,
      channel_post: {
        message_id: 1, date: 1, chat: { id: -2001, type: 'channel', title: 'News' },
        text: 'Not delivered', document: { file_id: 'not-downloaded' },
      },
    });
    expect(writes).toEqual([]);
    expect((await list({ account: 'discovery-a' })).channels.map((entry) => entry.kind)).toEqual(['group', 'channel']);
    handleUpdate('discovery-a', {
      update_id: 3,
      my_chat_member: { chat: { id: -1001, type: 'supergroup' }, new_chat_member: { status: 'left' } },
    });
    expect((await list({ account: 'discovery-a' })).channels.map((entry) => entry.id)).toEqual(['-2001']);
    expect(networkCalls).toBe(0);
  });

  test('ordinary messages and reactions retain their delivery, while bot messages stay suppressed', () => {
    handleUpdate('discovery-a', {
      update_id: 1,
      message: { message_id: 1, date: 1, chat: { id: 42, type: 'private', first_name: 'Ada' }, from: { id: 42 }, text: 'Hello' },
    });
    expect(writes[0]).toMatchObject({ line: 'metro://telegram-bot/discovery-a/42', text: 'Hello', is_private: true, message_id: '1' });
    handleUpdate('discovery-a', {
      update_id: 2,
      message: { message_id: 2, date: 1, chat: { id: 43, type: 'private' }, from: { id: 43, is_bot: true }, text: 'Bot message' },
    });
    expect(writes).toHaveLength(1);
    handleUpdate('discovery-a', {
      update_id: 3,
      message_reaction: {
        message_id: 1, date: 1, chat: { id: 42, type: 'private' }, user: { id: 42 },
        old_reaction: [], new_reaction: [{ type: 'emoji', emoji: '❤' }],
      },
    });
    handleUpdate('discovery-a', {
      update_id: 4,
      message_reaction_count: {
        message_id: 1, date: 1, chat: { id: 42, type: 'private' },
        reactions: [{ type: { type: 'emoji', emoji: '❤' }, total_count: 2 }],
      },
    });
    expect(writes).toHaveLength(3);
    for (const entry of writes.slice(1))
      expect(entry).toMatchObject({ line: 'metro://telegram-bot/discovery-a/42', event: { type: 'react', targetId: '1' } });
    expect(networkCalls).toBe(0);
  });
});
