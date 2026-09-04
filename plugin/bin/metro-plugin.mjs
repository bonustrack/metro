#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const mcpPath = join(pluginRoot, '.mcp.json');
const NAME_PREFIX = 'metro.box ';

const localUrl = () => `http://127.0.0.1:${Number(process.env.METRO_WEBHOOK_PORT) || 8420}`;

function agentsDir() {
  const explicit = process.env.METRO_AGENTS_DIR?.trim();
  return explicit ? explicit : join(homedir(), '.metro', 'agents');
}

function localAgents() {
  const dir = agentsDir();
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name, 'agent.json');
    if (!existsSync(path)) continue;
    try {
      const file = JSON.parse(readFileSync(path, 'utf8'));
      if (typeof file.id === 'string' && typeof file.name === 'string' && typeof file.key === 'string')
        out.push({ id: file.id, name: file.name, key: file.key });
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function pickAgent() {
  const agents = localAgents();
  const wanted = process.env.METRO_AGENT?.trim();
  if (wanted) {
    const found = agents.find((a) => a.name === wanted || a.id === wanted);
    if (!found) throw new Error(`no local agent named '${wanted}' in ${agentsDir()}`);
    return found;
  }
  if (agents.length === 1) return agents[0];
  throw new Error(
    agents.length === 0
      ? 'no agent on this machine yet — start metro serve and create or restore one in the web UI'
      : `several agents on this machine — set METRO_AGENT to one of: ${agents.map((a) => a.name).join(', ')}`,
  );
}

async function api(path, key) {
  let res;
  try {
    res = await fetch(`${localUrl()}${path}`, { headers: { authorization: `Bearer ${key}` } });
  } catch {
    throw new Error(`no metro daemon on ${localUrl()} — start one with: metro serve`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = typeof body?.error === 'string' ? body.error : `the daemon answered ${res.status}`;
    const err = new Error(detail);
    err.status = res.status;
    throw err;
  }
  return body;
}

function serverEntries(rawJson) {
  const servers = JSON.parse(rawJson)?.mcpServers;
  if (typeof servers !== 'object' || servers === null)
    throw new Error('the daemon returned an unexpected mcpServers shape');
  const out = {};
  for (const [key, value] of Object.entries(servers)) {
    const name = key.startsWith(NAME_PREFIX) ? key.slice(NAME_PREFIX.length) : key;
    out[name] = {
      type: value.type ?? 'http',
      url: value.url,
      headersHelper: 'node "${CLAUDE_PLUGIN_ROOT}/bin/metro-plugin.mjs" headers',
    };
  }
  return out;
}

async function refresh() {
  const agent = pickAgent();
  const body = await api('/api/cli/mcp', agent.key);
  const servers = serverEntries(body.json);
  writeFileSync(mcpPath, `${JSON.stringify(servers, null, 2)}\n`);
  const names = Object.keys(servers);
  process.stdout.write(
    `agent '${agent.name}': ${names.length} server(s) written to the plugin\n` +
      (names.length ? `  ${names.join('\n  ')}\n` : '') +
      'Run /reload-plugins to apply in this session.\n',
  );
}

function headers() {
  let agent;
  try {
    agent = pickAgent();
  } catch (err) {
    process.stderr.write(`metro: ${err.message}\n`);
    process.stdout.write('{}\n');
    return;
  }
  process.stdout.write(`${JSON.stringify({ Authorization: `Bearer ${agent.key}` })}\n`);
}

async function status() {
  const agent = pickAgent();
  const body = await api('/api/cli/session', agent.key);
  let count = 0;
  try {
    count = Object.keys(JSON.parse(readFileSync(mcpPath, 'utf8'))).length;
  } catch {
    count = 0;
  }
  process.stdout.write(`agent '${body.agent}' on ${localUrl()} · ${count} server(s) loaded\n`);
}

const command = process.argv[2];
const run = { refresh, headers: () => Promise.resolve(headers()), status }[command];

if (run === undefined) {
  process.stderr.write('usage: metro-plugin.mjs <refresh|headers|status>\n');
  process.exit(1);
}

run().catch((err) => {
  process.stderr.write(`metro: ${err.message}\n`);
  process.exit(err.status === 401 ? 2 : 1);
});
