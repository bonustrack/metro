#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const agentsDir = () => process.env.METRO_AGENTS_DIR || join(homedir(), '.metro', 'agents');
const MCP_TOKEN = /^mcp_[A-Za-z0-9_-]{43}$/;

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

function readMcpToken() {
  try {
    const token = readFileSync(join(agentsDir(), 'mcp-token'), 'utf8').trim();
    return MCP_TOKEN.test(token) ? token : null;
  } catch {
    return null;
  }
}

const command = process.argv[2];

if (command === 'mcp-headers') {
  const token = readMcpToken();
  if (token !== null) process.stdout.write(`${JSON.stringify({ Authorization: `Bearer ${token}` })}\n`);
  process.exit(0);
}

if (command !== 'headers') {
  process.stderr.write('usage: metro-plugin.mjs headers | mcp-headers\n');
  process.exit(1);
}

try {
  process.stdout.write(`${JSON.stringify({ Authorization: `Bearer ${readAgent().key}` })}\n`);
} catch (err) {
  process.stderr.write(`metro: ${err.message}\n`);
  process.stdout.write('{}\n');
}
