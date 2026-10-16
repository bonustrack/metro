import { describe, expect, test } from 'bun:test';
import type { Vault } from '@metro-labs/client/api/vault';
import { keyLastUsed } from '../src/lib/tools-view.ts';

describe('when a secret key was last used', () => {
  const vault: Vault = {
    available: true,
    enabled: true,
    running: true,
    problem: null,
    browsers: null,
    secrets: [],
    recent: [
      { at: '2026-10-16T08:00:00.000Z', method: 'GET', host: 'a', path: '/', status: 200, swapped: ['s1'] },
      { at: '2026-10-16T10:00:00.000Z', method: 'GET', host: 'a', path: '/', status: 200, swapped: ['s1', 's2'] },
      { at: '2026-10-16T09:00:00.000Z', method: 'GET', host: 'b', path: '/', status: 200, swapped: [] },
    ],
  };

  test('the newest request that swapped it in', () => {
    expect(keyLastUsed(vault, 's1')).toBe('2026-10-16T10:00:00.000Z');
    expect(keyLastUsed(vault, 's2')).toBe('2026-10-16T10:00:00.000Z');
    expect(keyLastUsed(vault, 's3')).toBeNull();
  });
});
