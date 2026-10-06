import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DIRECTORY_LIMIT } from '@metro-labs/core/stations/channel-directory';
import { channelFiles } from '../src/channel-files.ts';
import { ObservedChats } from '../src/observed-chats.ts';
import { telegramBotStation } from '../src/station.ts';

const originalDir = process.env.TELEGRAM_BOT_STATE_DIR;
let dir: string;
let books: ObservedChats[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'telegram-bot-directory-'));
  process.env.TELEGRAM_BOT_STATE_DIR = dir;
  books = [];
});

afterEach(() => {
  for (const book of books) book.flush();
  if (originalDir === undefined) delete process.env.TELEGRAM_BOT_STATE_DIR;
  else process.env.TELEGRAM_BOT_STATE_DIR = originalDir;
  rmSync(dir, { recursive: true, force: true });
});

function bookFor(account: string): ObservedChats {
  const book = new ObservedChats(account, channelFiles.path(account));
  books.push(book);
  return book;
}

function observe(book: ObservedChats, name: string): void {
  book.observe({
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      chat: { id: 42, type: 'private', first_name: name },
      text: 'Never persist this body',
      document: { file_id: 'private-file', file_name: 'secret.pdf' },
      from: { id: 99, username: 'not-a-chat' },
    },
  });
}

describe('telegram-bot observed metadata persistence', () => {
  test('reloads only metadata from a private file, with account-local names and lines', () => {
    const first = bookFor('first');
    const second = bookFor('second');
    observe(first, 'First account');
    observe(second, 'Second account');
    first.flush();
    second.flush();
    expect(statSync(channelFiles.path('first')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(channelFiles.path('first'), 'utf8'))).toEqual({
      version: 1, account: 'first', channels: [{ id: '42', kind: 'direct', name: 'First account' }],
    });
    expect(bookFor('first').snapshot().channels).toEqual([
      { id: '42', kind: 'direct', name: 'First account', line: 'metro://telegram-bot/first/42' },
    ]);
    expect(bookFor('second').snapshot().channels).toEqual([
      { id: '42', kind: 'direct', name: 'Second account', line: 'metro://telegram-bot/second/42' },
    ]);
  });

  test('saves observed metadata automatically after the debounce', async () => {
    const book = bookFor('first');
    observe(book, 'Saved automatically');
    expect(existsSync(channelFiles.path('first'))).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 2100));
    expect(bookFor('first').snapshot().channels[0]?.name).toBe('Saved automatically');
    expect(statSync(channelFiles.path('first')).mode & 0o777).toBe(0o600);
  });

  test('persisted membership removals stay absent after reload', () => {
    const book = bookFor('first');
    observe(book, 'First account');
    book.flush();
    book.observe({ update_id: 2, my_chat_member: { chat: { id: 42, type: 'private' }, new_chat_member: { status: 'kicked' } } });
    book.flush();
    expect(bookFor('first').snapshot().channels).toEqual([]);
  });

  test('validates account identity and reconstructs canonical lines instead of trusting saved data', () => {
    writeFileSync(channelFiles.path('first'), JSON.stringify({
      version: 1,
      account: 'first',
      channels: [
        { id: '42', kind: 'direct', name: 'Known', line: 'metro://telegram-bot/second/99', text: 'drop me' },
        { id: '-100/7', kind: 'thread', name: 'Topic' },
        { id: 'user/43', kind: 'direct' },
        { id: '43/2', kind: 'group' },
        { id: '43', kind: 'thread' },
        { id: '9007199254740992', kind: 'direct' },
        { id: '44', kind: 'unknown' },
      ],
    }));
    const book = bookFor('first');
    expect(book.snapshot().channels).toEqual([
      { id: '42', kind: 'direct', name: 'Known', line: 'metro://telegram-bot/first/42' },
      { id: '-100/7', kind: 'thread', name: 'Topic', line: 'metro://telegram-bot/first/-100/7' },
    ]);
    const wrongAccount = new ObservedChats('second', channelFiles.path('first'));
    expect(wrongAccount.snapshot().channels).toEqual([]);
    book.flush();
    expect(statSync(channelFiles.path('first')).mode & 0o777).toBe(0o600);
    expect(readFileSync(channelFiles.path('first'), 'utf8')).not.toContain('drop me');
  });

  test('bounds loaded entries and names, and treats corrupt storage as an incomplete empty directory', () => {
    writeFileSync(channelFiles.path('first'), JSON.stringify({
      version: 1, account: 'first', channels: Array.from({ length: DIRECTORY_LIMIT + 2 }, (_, index) => ({
        id: String(index + 1), kind: 'direct', name: 'x'.repeat(500),
      })),
    }));
    const book = bookFor('first');
    expect(book.snapshot().channels).toHaveLength(DIRECTORY_LIMIT);
    expect(book.snapshot().channels[0]?.id).toBe('3');
    expect(book.snapshot().channels[0]?.name).toHaveLength(256);
    writeFileSync(channelFiles.path('second'), '{broken');
    const broken = bookFor('second').snapshot();
    expect(broken.channels).toEqual([]);
    expect(broken.capability.complete).toBe(false);
  });

  test('station detach and orphan cleanup remove only the intended metadata files', () => {
    for (const account of ['first', 'second', 'orphan']) {
      const book = bookFor(account);
      observe(book, account);
      book.flush();
    }
    writeFileSync(join(dir, 'unrelated.json'), '{}');
    expect(telegramBotStation.discoversChannels).toBe(true);
    telegramBotStation.forget?.('first');
    expect(existsSync(channelFiles.path('first'))).toBe(false);
    expect(existsSync(channelFiles.path('second'))).toBe(true);
    telegramBotStation.forgetExcept?.(['second']);
    expect(existsSync(channelFiles.path('orphan'))).toBe(false);
    expect(existsSync(channelFiles.path('second'))).toBe(true);
    expect(existsSync(join(dir, 'unrelated.json'))).toBe(true);
  });
});
