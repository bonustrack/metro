import { afterEach, describe, expect, test } from 'bun:test';
import { agentForKey, registerKey, setKeyMap } from '../src/db/key-map.ts';

afterEach(() => setKeyMap([]));

describe('key map', () => {
  test('resolves an agent from a materialized key', () => {
    setKeyMap([
      { key: 'mk_alpha', agent: 'tony' },
      { key: 'mk_beta', agent: 'wan' },
    ]);
    expect(agentForKey('mk_alpha')).toBe('tony');
    expect(agentForKey('mk_beta')).toBe('wan');
  });

  test('unknown, empty and near-miss tokens resolve to nothing', () => {
    setKeyMap([{ key: 'mk_alpha', agent: 'tony' }]);
    expect(agentForKey('mk_alph')).toBeUndefined();
    expect(agentForKey('mk_alpha ')).toBeUndefined();
    expect(agentForKey('')).toBeUndefined();
    expect(agentForKey('tony')).toBeUndefined();
  });

  test('setKeyMap replaces the previous generation', () => {
    setKeyMap([{ key: 'mk_alpha', agent: 'tony' }]);
    setKeyMap([{ key: 'mk_beta', agent: 'wan' }]);
    expect(agentForKey('mk_alpha')).toBeUndefined();
    expect(agentForKey('mk_beta')).toBe('wan');
  });

  test('registerKey adds a key minted after boot without a restart', () => {
    setKeyMap([{ key: 'mk_alpha', agent: 'tony' }]);
    registerKey('mk_fresh', 'newbie');
    expect(agentForKey('mk_fresh')).toBe('newbie');
    expect(agentForKey('mk_alpha')).toBe('tony');
  });

  test('blank keys and blank agents are never registered', () => {
    setKeyMap([
      { key: '', agent: 'tony' },
      { key: 'mk_x', agent: '' },
    ]);
    registerKey('', 'tony');
    registerKey('mk_y', '');
    expect(agentForKey('')).toBeUndefined();
    expect(agentForKey('mk_x')).toBeUndefined();
    expect(agentForKey('mk_y')).toBeUndefined();
  });
});
