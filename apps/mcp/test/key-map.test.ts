import { afterEach, describe, expect, test } from 'bun:test';
import {
  agentIdForKey,
  registerKey,
  setKeyMap,
  unregisterAgentKeys,
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

  test('unregisterAgentKeys evicts every key of one agent and nobody else', () => {
    setKeyMap([
      { key: 'mk_ada_default', agentId: 7 },
      { key: 'mk_ada_second', agentId: 7 },
      { key: 'mk_bob', agentId: 8 },
    ]);
    registerKey('mk_ada_third', 7);
    unregisterAgentKeys(7);
    expect(agentIdForKey('mk_ada_default')).toBeUndefined();
    expect(agentIdForKey('mk_ada_second')).toBeUndefined();
    expect(agentIdForKey('mk_ada_third')).toBeUndefined();
    expect(agentIdForKey('mk_bob')).toBe(8);
  });

  test('unregistering an agent with no keys is a no-op', () => {
    setKeyMap([{ key: 'mk_bob', agentId: 8 }]);
    unregisterAgentKeys(99);
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
  });
});
