#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const agentsDir = () => process.env.METRO_AGENTS_DIR || join(homedir(), '.metro', 'agents');

function readAgent() {
  const path = join(agentsDir(), 'agent.json');
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`no agent on this machine yet (${path})`);
  }
  if (typeof parsed?.key !== 'string') throw new Error(`no agent key in ${path}`);
  return parsed;
}

if (process.argv[2] !== 'headers') {
  process.stderr.write('usage: metro-plugin.mjs headers\n');
  process.exit(1);
}

try {
  process.stdout.write(`${JSON.stringify({ Authorization: `Bearer ${readAgent().key}` })}\n`);
} catch (err) {
  process.stderr.write(`metro: ${err.message}\n`);
  process.stdout.write('{}\n');
}
