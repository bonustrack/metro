import { afterEach, describe, expect, test } from 'bun:test';
import {
  agentIdForKey,
  hasAnyKey,
  registerKey,
  setKeyMap,
  unregisterAgentKey,
} from '../src/db/key-map.ts';

afterEach(() => setKeyMap([]));

describe('key map', () => {
  test('resolves an agent id from a materialized key', () => {
    setKeyMap([
      { key: 'mk_alpha', agentId: 1 },
      { key: 'mk_beta', agentId: 2 },
    ]);
    expect(agentIdForKey('mk_alpha')).toBe(1);
    expect(agentIdForKey('mk_beta')).toBe(2);
  });

  test('two agents sharing a name still resolve to their own id', () => {
    setKeyMap([
      { key: 'mk_ada_tony', agentId: 7 },
      { key: 'mk_bob_tony', agentId: 8 },
    ]);
    expect(agentIdForKey('mk_ada_tony')).toBe(7);
    expect(agentIdForKey('mk_bob_tony')).toBe(8);
  });

  test('unknown, empty and near-miss tokens resolve to nothing', () => {
    setKeyMap([{ key: 'mk_alpha', agentId: 1 }]);
    expect(agentIdForKey('mk_alph')).toBeUndefined();
    expect(agentIdForKey('mk_alpha ')).toBeUndefined();
    expect(agentIdForKey('')).toBeUndefined();
    expect(agentIdForKey('tony')).toBeUndefined();
  });

  test('setKeyMap replaces the previous generation', () => {
    setKeyMap([{ key: 'mk_alpha', agentId: 1 }]);
    setKeyMap([{ key: 'mk_beta', agentId: 2 }]);
    expect(agentIdForKey('mk_alpha')).toBeUndefined();
    expect(agentIdForKey('mk_beta')).toBe(2);
  });

  test('registerKey adds a key minted after boot without a restart', () => {
    setKeyMap([{ key: 'mk_alpha', agentId: 1 }]);
    registerKey('mk_fresh', 42);
    expect(agentIdForKey('mk_fresh')).toBe(42);
    expect(agentIdForKey('mk_alpha')).toBe(1);
  });

  test('registerKey alone leaves the old key of that agent valid', () => {
    setKeyMap([{ key: 'mk_ada_old', agentId: 7 }]);
    registerKey('mk_ada_new', 7);
    expect(agentIdForKey('mk_ada_old')).toBe(7);
    expect(agentIdForKey('mk_ada_new')).toBe(7);
  });

  test('unregisterAgentKey evicts that agent key and nobody else', () => {
    setKeyMap([
      { key: 'mk_ada', agentId: 7 },
      { key: 'mk_bob', agentId: 8 },
    ]);
    unregisterAgentKey(7);
    expect(agentIdForKey('mk_ada')).toBeUndefined();
    expect(agentIdForKey('mk_bob')).toBe(8);
  });

  test('unregistering an agent with no key is a no-op', () => {
    setKeyMap([{ key: 'mk_bob', agentId: 8 }]);
    unregisterAgentKey(99);
    expect(agentIdForKey('mk_bob')).toBe(8);
  });

  test('blank keys and non-positive agent ids are never registered', () => {
    setKeyMap([
      { key: '', agentId: 1 },
      { key: 'mk_x', agentId: 0 },
      { key: 'mk_z', agentId: -1 },
    ]);
    registerKey('', 1);
    registerKey('mk_y', 0);
    expect(agentIdForKey('')).toBeUndefined();
    expect(agentIdForKey('mk_x')).toBeUndefined();
    expect(agentIdForKey('mk_z')).toBeUndefined();
    expect(agentIdForKey('mk_y')).toBeUndefined();
    expect(hasAnyKey()).toBe(false);
  });

  test('hasAnyKey reports whether the daemon can authenticate anyone', () => {
    expect(hasAnyKey()).toBe(false);
    setKeyMap([{ key: 'mk_ada', agentId: 7 }]);
    expect(hasAnyKey()).toBe(true);
    unregisterAgentKey(7);
    expect(hasAnyKey()).toBe(false);
  });

  test('the map exposes no way to read a key back out of it', async () => {
    const mod: Record<string, unknown> = await import('../src/db/key-map.ts');
    expect(Object.keys(mod).sort()).toEqual([
      'agentIdForKey',
      'hasAnyKey',
      'registerKey',
      'setKeyMap',
      'unregisterAgentKey',
    ]);
  });
});
