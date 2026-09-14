import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const pluginDir = join(import.meta.dir, '..', '..', '..', 'plugin');
const manifest = JSON.parse(
  readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'),
) as Record<string, unknown>;

describe('the plugin manifest', () => {
  test('keeps its hooks at the standard path and names them nowhere else', () => {
    expect(existsSync(join(pluginDir, 'hooks', 'hooks.json'))).toBe(true);
    expect(manifest.hooks).toBeUndefined();
  });

  test('carries the skills directory and a version Claude Code can compare', () => {
    expect(manifest.skills).toBe('./skills/');
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
