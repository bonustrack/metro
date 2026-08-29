import { describe, expect, test } from 'bun:test';
import { claudeArgs } from '../src/claude.ts';

describe('metro claude hands everything to claude untouched', () => {
  test('the channel flag comes first, then the user arguments verbatim', () => {
    expect(claudeArgs(['-r', 'abc'])).toEqual([
      '--dangerously-load-development-channels',
      'server:metro',
      '-r',
      'abc',
    ]);
  });

  test('unknown, future or odd flags pass through unparsed', () => {
    const odd = ['--dangerously-something-new=yes', '--', '-c', 'a b', '--flag-with=equals'];
    expect(claudeArgs(odd).slice(2)).toEqual(odd);
  });

  test('no arguments means only the channel flag', () => {
    expect(claudeArgs([])).toEqual([
      '--dangerously-load-development-channels',
      'server:metro',
    ]);
  });
});
