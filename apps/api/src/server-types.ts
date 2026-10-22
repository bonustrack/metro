export type AgentKind = 'box' | 'remote';

export const ADD_AGENT_ADMIN = 'Only an admin of the organization can add an agent.';

export interface ServerEntry {
  id: string;
  kind: AgentKind;
  host: string | null;
  name: string | null;
  addedAt: string;
  instanceId: string | null;
  launchedAt: string | null;
  avatar: string | null;
  slug: string | null;
  awsConnection: string | null;
}

const HOST_RE = /^[a-z0-9][a-z0-9.-]*(?::\d{1,5})?$/;
const HOST_MAX = 253;
const NAME_MAX = 40;

export function parseServerHost(raw: string): string | null {
  const host = raw.trim().toLowerCase();
  return host.length <= HOST_MAX && HOST_RE.test(host) ? host : null;
}

export function parseServerName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/[\p{Cc}]/gu, '').trim().slice(0, NAME_MAX);
  return name === '' ? null : name;
}

export const agentKindOf = (raw: string): AgentKind => (raw === 'remote' ? 'remote' : 'box');
