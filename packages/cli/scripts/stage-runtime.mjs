#!/usr/bin/env node
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = join(CLI, '..', '..');
const OUT = join(CLI, 'runtime');
const MODULES = join(OUT, 'node_modules', '@metro-labs');

const CORE_SOURCES = [
  ['apps/daemon', 'daemon'],
  ['packages/core', 'core'],
  ['packages/http', 'http'],
];
const STATION_SOURCES = [
  ['packages/xmtp', 'xmtp'],
  ['packages/telegram-bot', 'telegram-bot'],
  ['packages/telegram', 'telegram'],
  ['packages/discord-bot', 'discord-bot'],
  ['packages/whatsapp', 'whatsapp'],
  ['packages/webhook', 'webhook'],
];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(MODULES, { recursive: true });

for (const [from, name] of [...CORE_SOURCES, ...STATION_SOURCES]) {
  const src = join(REPO, from);
  const dest = join(MODULES, name);
  mkdirSync(dest, { recursive: true });
  cpSync(join(src, 'src'), join(dest, 'src'), { recursive: true });
  cpSync(join(src, 'package.json'), join(dest, 'package.json'));
}

mkdirSync(join(OUT, 'trains'), { recursive: true });
writeFileSync(join(OUT, 'trains', '.keep'), '');
writeFileSync(join(OUT, 'server.ts'), "import './node_modules/@metro-labs/daemon/src/server.ts';\n");

const { version } = JSON.parse(readFileSync(join(CLI, 'package.json'), 'utf8'));
const MARKET = join(OUT, 'marketplace');
mkdirSync(join(MARKET, '.claude-plugin'), { recursive: true });
cpSync(join(REPO, '.claude-plugin', 'marketplace.json'), join(MARKET, '.claude-plugin', 'marketplace.json'));
cpSync(join(REPO, 'plugin'), join(MARKET, 'plugin'), { recursive: true });
const pluginManifestPath = join(MARKET, 'plugin', '.claude-plugin', 'plugin.json');
const pluginManifest = JSON.parse(readFileSync(pluginManifestPath, 'utf8'));
pluginManifest.version = version;
writeFileSync(pluginManifestPath, `${JSON.stringify(pluginManifest, null, 2)}\n`);
writeFileSync(join(MARKET, 'plugin', '.mcp.json'), '{}\n');

const vendor = (from) => {
  const { dependencies = {} } = JSON.parse(readFileSync(join(REPO, from, 'package.json'), 'utf8'));
  return Object.fromEntries(
    Object.entries(dependencies)
      .filter(([name]) => !name.startsWith('@metro-labs/'))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
};
const manifest = {
  core: Object.fromEntries(
    CORE_SOURCES.flatMap(([from]) => Object.entries(vendor(from))).sort(([a], [b]) => a.localeCompare(b)),
  ),
  stations: Object.fromEntries(STATION_SOURCES.map(([from, name]) => [name, vendor(from)])),
};
writeFileSync(join(OUT, 'stations.json'), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(OUT, 'runtime.json'), `${JSON.stringify({ version }, null, 2)}\n`);
process.stdout.write(`staged the metro runtime ${version}\n`);
