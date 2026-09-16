import { call } from './client.js';
import { isRecord } from './accounts.js';

export interface AgentBundle {
  version: 1;
  agent: { id: string; name: string; key: string; stations: { station: string }[] };
  connectors: unknown[];
}

export interface RestoredAgent {
  id: string;
  name: string;
  stations: number;
  connectors: number;
}

const unexpected = (): Error => new Error('Metro returned an unexpected response.');

export async function fetchBundle(agentId: string): Promise<AgentBundle> {
  const body = await call({ method: 'GET', path: `/${agentId}/bundle` });
  if (!isRecord(body) || body.version !== 1 || !isRecord(body.agent)) throw unexpected();
  const agent = body.agent;
  if (typeof agent.id !== 'string' || typeof agent.name !== 'string' || typeof agent.key !== 'string') throw unexpected();
  const stations = Array.isArray(agent.stations)
    ? agent.stations.filter((s): s is { station: string } => isRecord(s) && typeof s.station === 'string')
    : [];
  return {
    version: 1,
    agent: { ...agent, id: agent.id, name: agent.name, key: agent.key, stations },
    connectors: Array.isArray(body.connectors) ? body.connectors : [],
  };
}

export async function restoreBundle(bundle: unknown): Promise<RestoredAgent> {
  const body = await call({
    method: 'POST',
    path: '/restore',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bundle),
  });
  if (!isRecord(body) || typeof body.id !== 'string' || typeof body.name !== 'string') throw unexpected();
  return {
    id: body.id,
    name: body.name,
    stations: typeof body.stations === 'number' ? body.stations : 0,
    connectors: typeof body.connectors === 'number' ? body.connectors : 0,
  };
}
