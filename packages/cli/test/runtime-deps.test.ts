import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..', '..', '..');

const read = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

function stationManifests(): string[] {
  const out = [join(REPO, 'apps', 'mcp', 'package.json')];
  for (const name of readdirSync(join(REPO, 'packages'))) {
    if (name === 'cli') continue;
    out.push(join(REPO, 'packages', name, 'package.json'));
  }
  return out;
}

/**
 * The station packages are COPIED into runtime/node_modules/@metro-labs, so npm
 * never installs their manifests. Their dependencies only reach a user machine
 * because the CLI declares them. If that union drifts, `metro start` fails at
 * runtime on the user's box with a module-not-found, which is the worst place
 * to find out.
 */
function expected(): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const path of stationManifests()) {
    const deps = (read(path).dependencies ?? {}) as Record<string, string>;
    for (const [name, range] of Object.entries(deps)) {
      if (name.startsWith('@metro-labs/')) continue;
      if (name === 'drizzle-kit') continue;
      merged[name] = range;
    }
  }
  return merged;
}

describe('the CLI carries every dependency the staged runtime needs', () => {
  const declared = (read(join(REPO, 'packages', 'cli', 'package.json'))
    .dependencies ?? {}) as Record<string, string>;

  test('nothing a station needs is missing from the CLI manifest', () => {
    const missing = Object.keys(expected()).filter((n) => !(n in declared));
    expect(missing).toEqual([]);
  });

  test('the ranges match, so a station upgrade cannot leave the CLI behind', () => {
    const drifted = Object.entries(expected())
      .filter(([n, range]) => declared[n] !== range)
      .map(([n, range]) => `${n}: station wants ${range}, CLI has ${declared[n] ?? 'nothing'}`);
    expect(drifted).toEqual([]);
  });

  test('the CLI declares nothing extra it does not need', () => {
    const extra = Object.keys(declared).filter((n) => !(n in expected()));
    expect(extra).toEqual([]);
  });

  test('drizzle-kit stays out: only the Fly release command runs migrations', () => {
    expect(declared['drizzle-kit']).toBeUndefined();
  });
});
