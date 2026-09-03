#!/usr/bin/env node
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const mcpPath = join(pluginRoot, '.mcp.json');
const NAME_PREFIX = 'metro.box ';

const trimSlash = (raw) => raw.replace(/\/+$/, '');

function metroUrl() {
  const raw = process.env.METRO_URL?.trim();
  return raw ? trimSlash(raw) : 'https://mcp.metro.box';
}

function metroWebUrl() {
  const raw = process.env.METRO_UI_URL?.trim();
  return raw ? trimSlash(raw) : 'https://metro.box';
}

function configDir() {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg ? xdg : join(homedir(), '.config');
  return join(base, 'metro');
}

const credentialsPath = () => join(configDir(), 'credentials.json');

function readToken() {
  const fromEnv = process.env.METRO_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const parsed = JSON.parse(readFileSync(credentialsPath(), 'utf8'));
    if (typeof parsed?.token !== 'string' || parsed.token === '') return null;
    return (parsed.url ?? 'https://mcp.metro.box') === metroUrl()
      ? parsed.token
      : null;
  } catch {
    return null;
  }
}

function writeToken(token) {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(
    credentialsPath(),
    `${JSON.stringify({ token, url: metroUrl() })}\n`,
    { mode: 0o600 },
  );
  chmodSync(credentialsPath(), 0o600);
}

async function api(path, init = {}) {
  let res;
  try {
    res = await fetch(`${metroUrl()}${path}`, init);
  } catch {
    throw new Error(`could not reach ${metroUrl()}`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = typeof body?.error === 'string' ? body.error : `metro answered ${res.status}`;
    const err = new Error(detail);
    err.status = res.status;
    throw err;
  }
  return body;
}

const authed = (token) => ({ headers: { authorization: `Bearer ${token}` } });

function tokenOrExplain() {
  const token = readToken();
  if (token === null)
    throw new Error(
      `this machine is not signed in — get a code from the agent's page at ${metroWebUrl()}/#/authorize and run /metro:login <code>`,
    );
  return token;
}

function serverEntries(rawJson) {
  const servers = JSON.parse(rawJson)?.mcpServers;
  if (typeof servers !== 'object' || servers === null)
    throw new Error('metro returned an unexpected mcpServers shape');
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
  const token = tokenOrExplain();
  const body = await api('/api/cli/mcp', authed(token));
  const servers = serverEntries(body.json);
  writeFileSync(mcpPath, `${JSON.stringify(servers, null, 2)}\n`);
  const names = Object.keys(servers);
  process.stdout.write(
    `agent '${body.agent}': ${names.length} server(s) written to the plugin\n` +
      (names.length ? `  ${names.join('\n  ')}\n` : '') +
      'Run /reload-plugins to apply in this session.\n',
  );
}

async function login(code) {
  if (!code)
    throw new Error(
      `no code given — get one from the agent's page at ${metroWebUrl()}/#/authorize, then run /metro:login <code>`,
    );
  const body = await api('/api/cli/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: code.trim() }),
  });
  writeToken(body.token);
  process.stdout.write(`Authorized '${body.agent}' for ${body.email}.\n`);
  await refresh();
}

function headers() {
  const token = readToken();
  if (token === null) {
    process.stderr.write('metro: not signed in — run /metro:login <code>\n');
    process.stdout.write('{}\n');
    return;
  }
  process.stdout.write(`${JSON.stringify({ Authorization: `Bearer ${token}` })}\n`);
}

async function status() {
  const token = tokenOrExplain();
  const body = await api('/api/cli/session', authed(token));
  let count = 0;
  try {
    count = Object.keys(JSON.parse(readFileSync(mcpPath, 'utf8'))).length;
  } catch {
    count = 0;
  }
  process.stdout.write(
    `${body.email} · agent '${body.agent}' on ${metroUrl()} · ${count} server(s) loaded\n`,
  );
}

const command = process.argv[2];
const run = {
  login: () => login(process.argv[3]),
  refresh,
  headers: () => Promise.resolve(headers()),
  status,
}[command];

if (run === undefined) {
  process.stderr.write('usage: metro-plugin.mjs <login <code>|refresh|headers|status>\n');
  process.exit(1);
}

run().catch((err) => {
  process.stderr.write(`metro: ${err.message}\n`);
  process.exit(err.status === 401 ? 2 : 1);
});
