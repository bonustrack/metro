#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const agentsDir = () => process.env.METRO_AGENTS_DIR || join(homedir(), '.metro', 'agents');
const MCP_TOKEN = /^mcp_[A-Za-z0-9_-]{43}$/;

function readMcpToken() {
  try {
    const token = readFileSync(join(agentsDir(), 'mcp-token'), 'utf8').trim();
    return MCP_TOKEN.test(token) ? token : null;
  } catch {
    return null;
  }
}

const token = readMcpToken();
if (token !== null) process.stdout.write(`${JSON.stringify({ Authorization: `Bearer ${token}` })}\n`);
