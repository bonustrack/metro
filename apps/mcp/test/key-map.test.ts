import { afterEach, describe, expect, test } from 'bun:test';
import {
  agentIdForKey,
  hasAnyKey,
  registerKey,
  rotateAgentKey,
  setKeyMap,
  unregisterAgentKey,
} from '../src/db/key-map.ts';

afterEach(() => setKeyMap([]));

describe('key map', () => {
  test('resolves an agent id from a materialized key', () => {
    setKeyMap([
      { key: 'mk_alpha', agentId: 'agent000001' },
      { key: 'mk_beta', agentId: 'agent000002' },
    ]);
    expect(agentIdForKey('mk_alpha')).toBe('agent000001');
    expect(agentIdForKey('mk_beta')).toBe('agent000002');
  });

  test('two agents sharing a name still resolve to their own id', () => {
    setKeyMap([
      { key: 'mk_ada_tony', agentId: 'agent000007' },
      { key: 'mk_bob_tony', agentId: 'agent000008' },
    ]);
    expect(agentIdForKey('mk_ada_tony')).toBe('agent000007');
    expect(agentIdForKey('mk_bob_tony')).toBe('agent000008');
  });

  test('unknown, empty and near-miss tokens resolve to nothing', () => {
    setKeyMap([{ key: 'mk_alpha', agentId: 'agent000001' }]);
    expect(agentIdForKey('mk_alph')).toBeUndefined();
    expect(agentIdForKey('mk_alpha ')).toBeUndefined();
    expect(agentIdForKey('')).toBeUndefined();
    expect(agentIdForKey('tony')).toBeUndefined();
  });

  test('setKeyMap replaces the previous generation', () => {
    setKeyMap([{ key: 'mk_alpha', agentId: 'agent000001' }]);
    setKeyMap([{ key: 'mk_beta', agentId: 'agent000002' }]);
    expect(agentIdForKey('mk_alpha')).toBeUndefined();
    expect(agentIdForKey('mk_beta')).toBe('agent000002');
  });

  test('registerKey adds a key minted after boot without a restart', () => {
    setKeyMap([{ key: 'mk_alpha', agentId: 'agent000001' }]);
    registerKey('mk_fresh', 'agent000042');
    expect(agentIdForKey('mk_fresh')).toBe('agent000042');
    expect(agentIdForKey('mk_alpha')).toBe('agent000001');
  });

  test('registerKey alone leaves the old key valid, which is why rotation exists', () => {
    setKeyMap([{ key: 'mk_ada_old', agentId: 'agent000007' }]);
    registerKey('mk_ada_new', 'agent000007');
    expect(agentIdForKey('mk_ada_old')).toBe('agent000007');
    expect(agentIdForKey('mk_ada_new')).toBe('agent000007');
  });

  test('unregisterAgentKey evicts that agent key and nobody else', () => {
    setKeyMap([
      { key: 'mk_ada', agentId: 'agent000007' },
      { key: 'mk_bob', agentId: 'agent000008' },
    ]);
    unregisterAgentKey('agent000007');
    expect(agentIdForKey('mk_ada')).toBeUndefined();
    expect(agentIdForKey('mk_bob')).toBe('agent000008');
  });

  test('unregistering an agent with no key is a no-op', () => {
    setKeyMap([{ key: 'mk_bob', agentId: 'agent000008' }]);
    unregisterAgentKey('agent000099');
    expect(agentIdForKey('mk_bob')).toBe('agent000008');
  });

  test('blank keys and malformed agent ids are never registered', () => {
    setKeyMap([
      { key: '', agentId: 'agent000001' },
      { key: 'mk_x', agentId: '' },
      { key: 'mk_z', agentId: 'agent00000' },
      { key: 'mk_w', agentId: 'agent0000012' },
      { key: 'mk_v', agentId: '-gent000001' },
    ]);
    registerKey('', 'agent000001');
    registerKey('mk_y', 'not an id');
    for (const key of ['', 'mk_x', 'mk_z', 'mk_w', 'mk_v', 'mk_y'])
      expect(agentIdForKey(key)).toBeUndefined();
    expect(hasAnyKey()).toBe(false);
  });

  test('hasAnyKey reports whether the daemon can authenticate anyone', () => {
    expect(hasAnyKey()).toBe(false);
    setKeyMap([{ key: 'mk_ada', agentId: 'agent000007' }]);
    expect(hasAnyKey()).toBe(true);
    unregisterAgentKey('agent000007');
    expect(hasAnyKey()).toBe(false);
  });

  test('the map exposes no way to read a key back out of it', async () => {
    const mod: Record<string, unknown> = await import('../src/db/key-map.ts');
    expect(Object.keys(mod).sort()).toEqual([
      'agentIdForKey',
      'hasAnyKey',
      'registerKey',
      'rotateAgentKey',
      'setKeyMap',
      'unregisterAgentKey',
    ]);
  });
});

describe('rotateAgentKey', () => {
  test('the old key stops resolving and the new one starts, in one step', () => {
    setKeyMap([{ key: 'mk_ada_old', agentId: 'agent000007' }]);
    rotateAgentKey('agent000007', 'mk_ada_new');
    expect(agentIdForKey('mk_ada_old')).toBeUndefined();
    expect(agentIdForKey('mk_ada_new')).toBe('agent000007');
  });

  test('rotation never leaves two live keys for the same agent', () => {
    setKeyMap([{ key: 'mk_gen1', agentId: 'agent000007' }]);
    rotateAgentKey('agent000007', 'mk_gen2');
    rotateAgentKey('agent000007', 'mk_gen3');
    expect([
      agentIdForKey('mk_gen1'),
      agentIdForKey('mk_gen2'),
      agentIdForKey('mk_gen3'),
    ]).toEqual([undefined, undefined, 'agent000007']);
  });

  test('rotating one agent leaves every other agent key untouched', () => {
    setKeyMap([
      { key: 'mk_ada', agentId: 'agent000007' },
      { key: 'mk_bob', agentId: 'agent000008' },
    ]);
    rotateAgentKey('agent000007', 'mk_ada_new');
    expect(agentIdForKey('mk_bob')).toBe('agent000008');
    expect(agentIdForKey('mk_ada_new')).toBe('agent000007');
  });

  test('rotating to null revokes without granting anything', () => {
    setKeyMap([
      { key: 'mk_ada', agentId: 'agent000007' },
      { key: 'mk_bob', agentId: 'agent000008' },
    ]);
    rotateAgentKey('agent000007', null);
    expect(agentIdForKey('mk_ada')).toBeUndefined();
    expect(agentIdForKey('mk_bob')).toBe('agent000008');
    expect(hasAnyKey()).toBe(true);
  });

  test('rotating an agent that had no key just adds the new one', () => {
    setKeyMap([{ key: 'mk_bob', agentId: 'agent000008' }]);
    rotateAgentKey('agent000007', 'mk_ada');
    expect(agentIdForKey('mk_ada')).toBe('agent000007');
    expect(agentIdForKey('mk_bob')).toBe('agent000008');
  });
});
