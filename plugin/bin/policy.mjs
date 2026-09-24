import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const METRO_TOOL = /^mcp__metro__(.+)$/;
const RANK = { allow: 0, ask: 1, deny: 2 };
const LINE_FIELD = { get_profile: 'from' };
const STATION_ARG = new Set(['create_group', 'set_profile']);

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v : '');
const agentsDir = () => process.env.METRO_AGENTS_DIR?.trim() || join(homedir(), '.metro', 'agents');

function readSnapshot() {
  try {
    const parsed = JSON.parse(readFileSync(join(agentsDir(), 'policy.json'), 'utf8'));
    return isRecord(parsed) && parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

const fromLine = (line, override) => {
  const parts = line.split('/');
  return line.startsWith('metro://') && parts[2] && parts[3] ? [{ station: parts[2], account: override || parts[3] }] : [];
};

function stationOfAccount(snap, account) {
  const hits = Object.entries(isRecord(snap.stations) ? snap.stations : {}).filter(
    ([, ids]) => Array.isArray(ids) && ids.includes(account),
  );
  return hits.length === 1 ? hits[0][0] : undefined;
}

function targets(snap, name, input) {
  if (Array.isArray(snap.ungated) && snap.ungated.includes(name)) return [];
  const account = text(input.account);
  const line = text(input[LINE_FIELD[name] ?? 'line']);
  if (line) return fromLine(line, name in LINE_FIELD ? '' : account);
  const owners = isRecord(snap.owners) ? snap.owners : {};
  const station = (STATION_ARG.has(name) ? text(input.station) : text(owners[name])) || (account ? stationOfAccount(snap, account) : undefined);
  if (!station) return [];
  if (account) return [{ station, account }];
  const ids = isRecord(snap.stations) && Array.isArray(snap.stations[station]) ? snap.stations[station] : [];
  return ids.map((id) => ({ station, account: id }));
}

function decide(policy, name, group) {
  if (!isRecord(policy)) return 'allow';
  const byTool = isRecord(policy.tools) ? policy.tools[name] : undefined;
  const access = byTool ?? policy[group] ?? 'allow';
  return access in RANK ? access : 'allow';
}

const normalized = (name) => name.replace(/[^a-zA-Z0-9_-]/g, '_');

function connectorCall(snap, toolName) {
  for (const [server, entry] of Object.entries(isRecord(snap.connectors) ? snap.connectors : {})) {
    if (!isRecord(entry)) continue;
    const name = text(entry.name);
    const prefixes = [`mcp__plugin_metro_${server}__`, `mcp__${server}__`, `mcp__${normalized(`metro.box ${name}`)}__`];
    const prefix = prefixes.find((p) => toolName.startsWith(p) && toolName.length > p.length);
    if (prefix === undefined) continue;
    const called = toolName.slice(prefix.length);
    const tools = isRecord(entry.tools) ? entry.tools : {};
    const policy = isRecord(entry.policy) ? entry.policy : {};
    const known = [...Object.keys(tools), ...Object.keys(isRecord(policy.tools) ? policy.tools : {})];
    const tool = known.find((k) => k === called) ?? known.find((k) => normalized(k) === called) ?? called;
    return { name: name || server, tool, group: tools[tool] === 'read' ? 'read' : 'write', policy };
  }
  return null;
}

function connectorVerdict(snap, toolName) {
  const call = connectorCall(snap, toolName);
  if (call === null) return null;
  const access = decide(call.policy, call.tool, call.group);
  return access === 'allow' ? null : { access, tool: call.tool, owner: call.name, where: `${call.tool} on ${call.name}` };
}

export function policyVerdict(toolName, input) {
  const name = METRO_TOOL.exec(toolName)?.[1];
  if (name === undefined && !toolName.startsWith('mcp__')) return null;
  const snap = readSnapshot();
  if (snap === null) return null;
  if (name === undefined) return connectorVerdict(snap, toolName);
  const tools = isRecord(snap.tools) ? snap.tools : {};
  const group = tools[name] === 'read' ? 'read' : 'write';
  const accounts = isRecord(snap.accounts) ? snap.accounts : {};
  let verdict = null;
  for (const target of targets(snap, name, input)) {
    const access = decide(accounts[`${target.station}/${target.account}`], name, group);
    if (access !== 'allow' && (verdict === null || RANK[access] > RANK[verdict.access]))
      verdict = { access, tool: name, owner: target.station, where: `${name} on ${target.station} (${target.account})` };
  }
  return verdict;
}
