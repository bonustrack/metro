#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const agentsDir = () => process.env.METRO_AGENTS_DIR || join(homedir(), '.metro', 'agents');

function readAgent(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed?.key === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function pickAgent() {
  const dir = agentsDir();
  const fixed = readAgent(join(dir, 'agent.json'));
  if (fixed !== null) return fixed;
  if (!existsSync(dir)) throw new Error(`no agent on this machine yet (${dir})`);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const found = readAgent(join(dir, entry.name, 'agent.json'));
    if (found !== null) return found;
  }
  throw new Error(`no agent on this machine yet (${dir})`);
}

if (process.argv[2] !== 'headers') {
  process.stderr.write('usage: metro-plugin.mjs headers\n');
  process.exit(1);
}

try {
  process.stdout.write(`${JSON.stringify({ Authorization: `Bearer ${pickAgent().key}` })}\n`);
} catch (err) {
  process.stderr.write(`metro: ${err.message}\n`);
  process.stdout.write('{}\n');
}
