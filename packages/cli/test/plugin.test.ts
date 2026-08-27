import { describe, expect, test } from 'bun:test';
import { installPathFrom } from '../src/plugin.ts';

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
