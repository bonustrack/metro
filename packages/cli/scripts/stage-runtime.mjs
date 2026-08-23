#!/usr/bin/env node
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = join(CLI, '..', '..');
const OUT = join(CLI, 'runtime');
const MODULES = join(OUT, 'node_modules', '@metro-labs');

const SOURCES = [
  ['apps/mcp', 'mcp'],
  ['packages/xmtp', 'xmtp'],
  ['packages/telegram', 'telegram'],
  ['packages/telegram-user', 'telegram-user'],
  ['packages/discord', 'discord'],
  ['packages/whatsapp', 'whatsapp'],
  ['packages/webhook', 'webhook'],
];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(MODULES, { recursive: true });

for (const [from, name] of SOURCES) {
  const src = join(REPO, from);
  const dest = join(MODULES, name);
  mkdirSync(dest, { recursive: true });
  cpSync(join(src, 'src'), join(dest, 'src'), { recursive: true });
  cpSync(join(src, 'package.json'), join(dest, 'package.json'));
}

mkdirSync(join(OUT, 'trains'), { recursive: true });
writeFileSync(join(OUT, 'trains', '.keep'), '');

const { version } = JSON.parse(readFileSync(join(CLI, 'package.json'), 'utf8'));
writeFileSync(join(OUT, 'runtime.json'), `${JSON.stringify({ version }, null, 2)}\n`);
process.stdout.write(`staged the metro runtime ${version}\n`);
