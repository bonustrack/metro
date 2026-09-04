import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { localUrl } from './runtime.js';

const PROBE_MS = 3_000;
const READ_MS = 20_000;

export interface LocalAgent {
  id: string;
  name: string;
  key: string;
}

export function agentsDir(): string {
  const explicit = process.env.METRO_AGENTS_DIR?.trim();
  return explicit !== undefined && explicit !== '' ? explicit : join(homedir(), '.metro', 'agents');
}

export function localAgents(dir = agentsDir()): LocalAgent[] {
  if (!existsSync(dir)) return [];
  const out: LocalAgent[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name, 'agent.json');
    if (!existsSync(path)) continue;
    try {
      const file = JSON.parse(readFileSync(path, 'utf8')) as { id?: unknown; name?: unknown; key?: unknown };
      if (typeof file.id === 'string' && typeof file.name === 'string' && typeof file.key === 'string')
        out.push({ id: file.id, name: file.name, key: file.key });
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function pickLocalAgent(agents: LocalAgent[], wanted?: string): LocalAgent {
  if (wanted !== undefined && wanted !== '') {
    const found = agents.find((a) => a.name === wanted || a.id === wanted);
    if (found === undefined) throw new Error(`no local agent named '${wanted}'`);
    return found;
  }
  const only = agents[0];
  if (only !== undefined && agents.length === 1) return only;
  throw new Error(
    agents.length === 0
      ? 'no agent on this machine yet'
      : `several agents on this machine — name one: ${agents.map((a) => a.name).join(', ')}`,
  );
}

export async function localDaemonUp(base = localUrl()): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/mode`, { signal: AbortSignal.timeout(PROBE_MS) });
    const body = (await res.json()) as { mode?: unknown };
    return res.ok && body.mode === 'local';
  } catch {
    return false;
  }
}

export async function localMcpServers(agent: LocalAgent, base = localUrl()): Promise<string> {
  const res = await fetch(`${base}/api/cli/mcp`, {
    headers: { authorization: `Bearer ${agent.key}` },
    signal: AbortSignal.timeout(READ_MS),
  });
  if (!res.ok) throw new Error(`the local daemon answered ${String(res.status)} for the connectors`);
  const body = (await res.json()) as { json?: unknown };
  if (typeof body.json !== 'string') throw new Error('the local daemon returned an unexpected response');
  return body.json;
}
