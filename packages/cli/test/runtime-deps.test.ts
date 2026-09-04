import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLI = join(import.meta.dir, '..');
const REPO = join(CLI, '..', '..');
const HOSTED_ONLY = ['drizzle-kit', 'drizzle-orm', 'postgres'];
const STATIONS = ['xmtp', 'telegram-bot', 'telegram', 'discord-bot', 'whatsapp', 'webhook'];

const deps = (dir: string): Record<string, string> =>
  (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> })
    .dependencies ?? {};
const vendor = (dir: string): Record<string, string> =>
  Object.fromEntries(
    Object.entries(deps(dir)).filter(([n]) => !n.startsWith('@metro-labs/') && !HOSTED_ONLY.includes(n)),
  );

describe('the staged channel manifest', () => {
  const manifest = JSON.parse(readFileSync(join(CLI, 'runtime', 'stations.json'), 'utf8')) as {
    core: Record<string, string>;
    stations: Record<string, Record<string, string>>;
  };

  test('core is the daemon package minus the workspace and the hosted-only Postgres stack', () => {
    expect(manifest.core).toEqual(vendor(join(REPO, 'apps', 'mcp')));
    for (const name of HOSTED_ONLY) expect(manifest.core).not.toHaveProperty(name);
  });

  test('every channel lists exactly its own vendor SDKs', () => {
    expect(Object.keys(manifest.stations).sort()).toEqual([...STATIONS].sort());
    for (const station of STATIONS)
      expect(manifest.stations[station]).toEqual(vendor(join(REPO, 'packages', station)));
    expect(manifest.stations.webhook).toEqual({});
    expect(manifest.stations['telegram-bot']).toEqual({});
  });

  test('the npm package itself carries no runtime dependency at all', () => {
    expect(deps(CLI)).toEqual({});
  });
});
