import { describe, expect, test } from 'bun:test';
import { groupJump, isJumpKey, jumpScore, moveCursor, rankJump, tokensOf, type JumpEntry } from '../src/lib/jump.ts';
import { dialogOpen, listStep, plainKey } from '../src/lib/list-keys.ts';

const entry = (key: string, group: JumpEntry<null>['group'], crumbs: string[], extra: Partial<JumpEntry<null>> = {}): JumpEntry<null> => ({ key, group, crumbs, payload: null, ...extra });

const ENTRIES: JumpEntry<null>[] = [
  entry('agent:emma', 'agents', ['Emma'], { idle: true }),
  entry('agent:emmanuel', 'agents', ['Emmanuel'], { idle: true }),
  entry('agent:tony', 'agents', ['Tony'], { idle: true }),
  entry('section:models', 'pages', ['Models'], { idle: true }),
  entry('page:emma:home', 'pages', ['Emma', 'Home']),
  entry('page:emma:chats', 'pages', ['Emma', 'Channels']),
  entry('page:emma:chats:voice', 'pages', ['Emma', 'Channels', 'Voice']),
  entry('page:emma:settings', 'pages', ['Emma', 'Settings']),
  entry('page:emma:settings:model', 'pages', ['Emma', 'Settings', 'Model']),
  entry('page:tony:settings:model', 'pages', ['Tony', 'Settings', 'Model']),
  entry('restart:emma', 'actions', ['Restart Emma'], { words: ['reboot'] }),
  entry('terminal:emma', 'actions', ["Open Emma's terminal"], { words: ['shell'] }),
  entry('restart:tony', 'actions', ['Restart Tony'], { words: ['reboot'] }),
];

const keys = (query: string): string[] => rankJump(ENTRIES, query).map((e) => e.key);

describe('Jump search', () => {
  test('an empty search shows only what is marked idle, agents first', () => {
    expect(keys('')).toEqual(['agent:emma', 'agent:emmanuel', 'agent:tony', 'section:models']);
  });

  test('every word must match, and an exact word ranks above a prefix', () => {
    expect(keys('emma')).toEqual([
      'agent:emma', 'agent:emmanuel',
      'page:emma:home', 'page:emma:chats', 'page:emma:settings', 'page:emma:chats:voice', 'page:emma:settings:model',
      'restart:emma', 'terminal:emma',
    ]);
    expect(keys('emma model')).toEqual(['page:emma:settings:model']);
    expect(keys('tony restart')).toEqual(['restart:tony']);
  });

  test('a prefix beats a word that only contains the letters, and the first crumb counts more', () => {
    const models = keys('model');
    expect(models[0]).toBe('section:models');
    expect(models.indexOf('page:emma:settings:model')).toBeLessThan(models.indexOf('page:tony:settings:model'));
    expect(jumpScore(entry('a', 'pages', ['Emma', 'Channels']), ['channel'])).toBeLessThan(jumpScore(entry('b', 'pages', ['Channels']), ['channel']) ?? 0);
    expect(jumpScore(entry('c', 'pages', ['Emma']), ['xyz'])).toBeNull();
  });

  test('extra words find an action by another name', () => {
    expect(keys('reboot')).toEqual(['restart:emma', 'restart:tony']);
    expect(keys('shell')).toEqual(['terminal:emma']);
  });

  test('results come grouped and capped per group', () => {
    const many = Array.from({ length: 12 }, (_, i) => entry(`page:${String(i)}`, 'pages', ['Page', String(i)]));
    expect(rankJump(many, 'page')).toHaveLength(6);
    expect(groupJump(rankJump(ENTRIES, 'emma')).map((g) => g.group)).toEqual(['agents', 'pages', 'actions']);
  });

  test('tokens ignore case and punctuation', () => {
    expect(tokensOf("  Emma's   TERMINAL ")).toEqual(['emma', 's', 'terminal']);
    expect(tokensOf('beta.312')).toEqual(['beta.312']);
  });

  test('the cursor wraps, and Cmd or Ctrl K opens Jump', () => {
    expect(moveCursor(0, -1, 4)).toBe(3);
    expect(moveCursor(3, 1, 4)).toBe(0);
    expect(moveCursor(2, 1, 0)).toBe(0);
    expect(isJumpKey('k', true, false)).toBe(true);
    expect(isJumpKey('K', false, true)).toBe(true);
    expect(isJumpKey('k', false, false)).toBe(false);
  });
});

describe('J and K in a list', () => {
  test('J and K move from the open row and stop at the ends, Enter opens, Escape clears', () => {
    expect(listStep(null, 'j', 3, 0)).toEqual({ cursor: 1, open: null });
    expect(listStep(null, 'k', 3, 0)).toEqual({ cursor: 0, open: null });
    expect(listStep(null, 'j', 3, -1)).toEqual({ cursor: 0, open: null });
    expect(listStep(2, 'j', 3, 0)).toEqual({ cursor: 2, open: null });
    expect(listStep(1, 'Enter', 3, 0)).toEqual({ cursor: 1, open: 1 });
    expect(listStep(null, 'Enter', 3, 0)).toBeNull();
    expect(listStep(1, 'Escape', 3, 0)).toEqual({ cursor: null, open: null });
    expect(listStep(null, 'j', 0, 0)).toBeNull();
    expect(listStep(0, 'x', 3, 0)).toBeNull();
  });

  test('a key with Shift, Meta, Control or Alt is not a list key', () => {
    const press = { key: 'j', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false };
    expect(plainKey(press)).toBe('j');
    expect(plainKey({ ...press, key: 'J', shiftKey: true })).toBeNull();
    expect(plainKey({ ...press, metaKey: true })).toBeNull();
    expect(plainKey({ ...press, key: 'Enter', ctrlKey: true })).toBeNull();
    expect(plainKey({ ...press, altKey: true })).toBeNull();
  });

  test('an open dialog or modal takes the keys away from the list', () => {
    const page = (open: boolean): { querySelector: (selector: string) => unknown } => ({ querySelector: (selector) => (open && selector === '[aria-modal="true"]' ? {} : null) });
    expect(dialogOpen(page(true))).toBe(true);
    expect(dialogOpen(page(false))).toBe(false);
    expect(dialogOpen(undefined)).toBe(false);
  });
});
