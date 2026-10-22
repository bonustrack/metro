import { builtInDaemon } from '../auth/daemon.js';
import { filled, isRecord, recordOf } from '../read.js';
import { approvalOf, type Approval, type Decision } from './approvals.js';
import { orgCall } from './org-connectors.js';

export const MCP_URL = 'https://mcp.metro.box/mcp';

export interface AgentKey {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface NewAgentKey {
  key: AgentKey;
  secret: string;
}

export interface RemoteApproval {
  approval: Approval;
  connector: string;
  connectorName: string | null;
  connectorUrl: string | null;
}

const JSON_HEADERS = { 'content-type': 'application/json' };
const SECRET_RE = /^mcp_[A-Za-z0-9_-]{43}$/;
const unexpected = (): Error => new Error('Metro returned an unexpected response.');
const base = (agent: string): string => `${builtInDaemon()}/api/agents/${encodeURIComponent(agent)}`;
const time = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function keyOf(value: unknown): AgentKey | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.label !== 'string') return null;
  const createdAt = time(value.createdAt);
  if (createdAt === null) return null;
  return { id: value.id, label: value.label, createdAt, lastUsedAt: time(value.lastUsedAt), revokedAt: time(value.revokedAt) };
}

export async function fetchAgentKeys(agent: string): Promise<AgentKey[]> {
  const body = await orgCall({ method: 'GET', base: base(agent), path: '/tokens' });
  if (!isRecord(body) || !Array.isArray(body.tokens)) throw unexpected();
  return body.tokens.flatMap((raw) => {
    const key = keyOf(raw);
    return key === null ? [] : [key];
  });
}

export async function createAgentKey(agent: string, label: string): Promise<NewAgentKey> {
  const body = recordOf(await orgCall({ method: 'POST', base: base(agent), path: '/tokens', headers: JSON_HEADERS, body: JSON.stringify({ label: label.trim() }) }));
  const key = keyOf(body.token);
  if (key === null || typeof body.key !== 'string' || !SECRET_RE.test(body.key)) throw unexpected();
  return { key, secret: body.key };
}

export async function revokeAgentKey(agent: string, id: string): Promise<void> {
  await orgCall({ method: 'DELETE', base: base(agent), path: `/tokens/${encodeURIComponent(id)}` });
}

export const claudeCommand = (secret: string): string => `claude mcp add --transport http metro ${MCP_URL} --header "Authorization: Bearer ${secret}"`;

function remoteApprovalOf(raw: unknown): RemoteApproval | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.tool !== 'string' || typeof raw.connector !== 'string') return null;
  const requestedAt = time(raw.requestedAt);
  const key = typeof raw.connectorKey === 'string' && raw.connectorKey !== '' ? raw.connectorKey : raw.connector;
  const approval = approvalOf({ id: raw.id, tool: `${key}.${raw.tool}`, preview: raw.preview, line: '', requestedAt: requestedAt === null ? '' : new Date(requestedAt).toISOString() });
  return approval === null ? null : { approval, connector: raw.connector, connectorName: filled(raw.connectorName), connectorUrl: filled(raw.connectorUrl) };
}

export async function fetchRemoteApprovals(agent: string): Promise<RemoteApproval[]> {
  const body = await orgCall({ method: 'GET', base: base(agent), path: '/approvals' });
  if (!isRecord(body) || !Array.isArray(body.approvals)) throw unexpected();
  return body.approvals
    .flatMap((raw) => {
      const found = remoteApprovalOf(raw);
      return found === null ? [] : [found];
    })
    .sort((a, b) => b.approval.requestedAt.localeCompare(a.approval.requestedAt));
}

export async function decideRemoteApproval(agent: string, id: string, decision: Decision): Promise<void> {
  await orgCall({ method: 'POST', base: base(agent), path: `/approvals/${encodeURIComponent(id)}`, headers: JSON_HEADERS, body: JSON.stringify({ decision }) });
}
