import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPathFrom, marketplaceSource, registeredMarketplacePath } from '../src/plugin.ts';

const REGISTRY = JSON.stringify({
  version: 2,
  plugins: {
    'metro@metro': [
      { scope: 'user', installPath: '/home/x/.claude/plugins/cache/metro/metro/0.1.0' },
    ],
    'other@market': [{ scope: 'user', installPath: '/elsewhere' }],
  },
});

describe('finding the installed plugin', () => {
  test('reads the metro install path out of the registry', () => {
    expect(installPathFrom(REGISTRY)).toBe(
      '/home/x/.claude/plugins/cache/metro/metro/0.1.0',
    );
  });

  test('a registry without the plugin, or malformed, resolves to null', () => {
    expect(installPathFrom('{"plugins":{}}')).toBe(null);
    expect(installPathFrom('{"plugins":{"metro@metro":[]}}')).toBe(null);
    expect(installPathFrom('{"plugins":{"metro@metro":[{}]}}')).toBe(null);
    expect(installPathFrom('not json')).toBe(null);
    expect(installPathFrom('null')).toBe(null);
  });
});

describe('where metro plugin installs from', () => {
  test('the bundled marketplace in the runtime store when it is staged, else the git repo', () => {
    const store = mkdtempSync(join(tmpdir(), 'metro-plugin-src-'));
    try {
      expect(marketplaceSource(store)).toBe('bonustrack/metro');
      mkdirSync(join(store, 'marketplace', '.claude-plugin'), { recursive: true });
      writeFileSync(join(store, 'marketplace', '.claude-plugin', 'marketplace.json'), '{"name":"metro","plugins":[]}');
      expect(marketplaceSource(store)).toBe(join(store, 'marketplace'));
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  });

  test('reads where a metro marketplace already points, and tells nothing registered from a bad answer', () => {
    expect(registeredMarketplacePath('[{"name":"metro","source":"github","installLocation":"/root/.claude/plugins/marketplaces/metro"}]')).toBe('/root/.claude/plugins/marketplaces/metro');
    expect(registeredMarketplacePath('[{"name":"metro","source":"directory","path":"/root/.metro/runtime/marketplace"}]')).toBe('/root/.metro/runtime/marketplace');
    expect(registeredMarketplacePath('[{"name":"other"}]')).toBeUndefined();
    expect(registeredMarketplacePath('not json')).toBeUndefined();
  });
});
