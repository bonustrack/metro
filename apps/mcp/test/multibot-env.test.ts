/**
 * Shared account-store helpers (csv/genIds). Per-station multi-bot env fallbacks
 * live in each station package's own tests (@metro-labs/discord, @metro-labs/telegram).
 */

import { describe, expect, test } from 'bun:test';
import { csv, genIds } from '@metro-labs/station-kit/account-store';

describe('account-store helpers', () => {
  test('csv trims, drops empties, and dedupes', () => {
    expect(csv(' a, b ,,c ')).toEqual(['a', 'b', 'c']);
    expect(csv('a,a,b')).toEqual(['a', 'b']);
    expect(csv(undefined)).toEqual([]);
  });
  test('genIds → prefix0..N-1', () => {
    expect(genIds('d', 1)).toEqual(['d0']);
    expect(genIds('t', 3)).toEqual(['t0', 't1', 't2']);
  });
});
