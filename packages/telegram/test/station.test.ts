import { describe, expect, test } from 'bun:test';
import { telegramStation } from '../src/station.ts';

describe('telegram station descriptor', () => {
  test('name and account flag', () => {
    expect(telegramStation.name).toBe('telegram');
    expect(telegramStation.hasAccounts).toBe(true);
    expect(telegramStation.attachmentMode).toBe('canonical');
  });

  test('message verbs', () => {
    expect([...telegramStation.messageVerbs].sort()).toEqual([
      'delete',
      'edit',
      'react',
      'read',
      'reply',
      'send',
      'unreact',
    ]);
  });
});
