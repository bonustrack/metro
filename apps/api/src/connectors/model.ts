import { isRecord } from '@metro-labs/core/is-record';
import { connectorPolicyOf, type ConnectorPolicy } from '@metro-labs/http/connector-delivery';
import type { AssignmentRow, ConnectorRow } from '@metro-labs/connectors/db/connectors';
import { detailOf, parsedJson, type ConnectorDetail } from '@metro-labs/connectors/model';

export interface ConnectorView {
  id: string;
  name: string;
  url: string;
  auth: string;
  header: string | null;
  signIn: 'connected' | 'disconnected' | null;
  server: string | null;
  verifiedAt: string | null;
  clientId: string | null;
  readOnly: boolean;
  policy: ConnectorPolicy;
  createdAt: string;
  updatedAt: string;
  agents: { id: string; readOnly: boolean; policy: ConnectorPolicy; assignedAt: string }[];
}

const READ_ONLY = '{"write":"deny"}';

export const readOnlyPolicy = (readOnly: boolean): string | null => (readOnly ? READ_ONLY : null);

export function isReadOnly(policy: string | null): boolean {
  const value = parsedJson(policy);
  return isRecord(value) && value.write === 'deny';
}

export function fullPolicy(policy: string | null): ConnectorPolicy {
  try {
    return connectorPolicyOf(policy === null ? {} : parsedJson(policy));
  } catch {
    return { read: 'deny', write: 'deny' };
  }
}

export function simplePolicy(policy: string | null): boolean {
  if (policy === null) return true;
  const value = parsedJson(policy);
  if (!isRecord(value) || !Object.keys(value).every((key) => ['read', 'write', 'tools'].includes(key))) return false;
  const reads: unknown[] = [undefined, 'allow'];
  const writes: unknown[] = [undefined, 'allow', 'deny'];
  if (!reads.includes(value.read) || !writes.includes(value.write)) return false;
  return value.tools === undefined || (isRecord(value.tools) && Object.keys(value.tools).length === 0);
}

function signInOf(row: ConnectorRow, detail: ConnectorDetail): ConnectorView['signIn'] {
  if (row.auth !== 'oauth') return null;
  return detail.signedInAt === undefined ? 'disconnected' : 'connected';
}

function publicServerName(url: string): string | null {
  try { return new URL(url).hostname; } catch { return null; }
}

export function connectorView(row: ConnectorRow, assignments: AssignmentRow[]): ConnectorView {
  const detail = detailOf(row.detail);
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    auth: row.auth,
    header: detail.header ?? null,
    signIn: signInOf(row, detail),
    server: detail.server === undefined ? null : publicServerName(row.url),
    verifiedAt: detail.verifiedAt ?? null,
    clientId: detail.clientId ?? null,
    readOnly: isReadOnly(row.policy),
    policy: fullPolicy(row.policy),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    agents: assignments
      .filter((a) => a.connector === row.id)
      .map((a) => ({ id: a.agent, readOnly: isReadOnly(a.policy), policy: fullPolicy(a.policy), assignedAt: a.createdAt })),
  };
}
