import { describe, expect, test } from 'bun:test';
import { telegramUserStation } from '../src/station.ts';

describe('telegram-user station descriptor', () => {
  test('name and account flag', () => {
    expect(telegramUserStation.name).toBe('telegram-user');
    expect(telegramUserStation.hasAccounts).toBe(true);
    expect(telegramUserStation.attachmentMode).toBe('canonical');
  });

  test('message verbs', () => {
    expect([...telegramUserStation.messageVerbs].sort()).toEqual([
      'delete',
      'edit',
      'react',
      'read',
      'reply',
      'send',
      'unreact',
    ]);
  });

  test('mutating verbs', () => {
    expect([...telegramUserStation.mutates].sort()).toEqual([
      'delete',
      'edit',
      'react',
      'send',
    ]);
  });
});
