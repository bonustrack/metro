import { isRecord } from '@metro-labs/core/is-record';
import { connectorPolicyOf, type ConnectorPolicy } from '@metro-labs/http/connector-policy';
import type { RemoteEvent } from '@metro-labs/http/connector-tools';
import { senderListOf } from '@metro-labs/http/sender-list';
import { eventNamesOf } from '@metro-labs/connectors/db/connector-subscriptions';
import type { AssignmentRow, ConnectorRow, SubscriptionState } from '@metro-labs/connectors/db/connectors';
import { detailOf, parsedJson, type ConnectorDetail } from '@metro-labs/connectors/model';

type SubscriptionStatus = 'pending' | 'active' | 'signed_out' | 'error';

interface OfferedEvent {
  name: string;
  title: string;
  description: string;
  sender: boolean;
}

interface SubscriptionView {
  event: string;
  status: SubscriptionStatus;
  error?: string;
}

interface AgentView {
  id: string;
  readOnly: boolean;
  policy: ConnectorPolicy;
  assignedAt: string;
  events: string[];
  senders: string[];
  subscriptions: SubscriptionView[];
}

export interface ConnectorEvents {
  offered: Map<string, RemoteEvent[]>;
  subscriptions: SubscriptionState[];
}

const NO_EVENTS: ConnectorEvents = { offered: new Map(), subscriptions: [] };

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
  events: OfferedEvent[];
  agents: AgentView[];
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

const offeredView = (event: RemoteEvent): OfferedEvent => ({ name: event.name, title: event.title, description: event.description, sender: event.sender !== undefined });

const statusOf = (status: string): SubscriptionStatus => (status === 'active' || status === 'signed_out' || status === 'error' ? status : 'pending');

function subscriptionsOf(rows: SubscriptionState[], connector: string, agent: string): SubscriptionView[] {
  return rows
    .filter((row) => row.connector === connector && row.agent === agent)
    .map((row) => ({ event: row.event, status: statusOf(row.status), ...(row.error === null || row.error === '' ? {} : { error: row.error }) }))
    .sort((a, b) => (a.event < b.event ? -1 : a.event > b.event ? 1 : 0));
}

function agentView(assignment: AssignmentRow, subscriptions: SubscriptionState[]): AgentView {
  return {
    id: assignment.agent,
    readOnly: isReadOnly(assignment.policy),
    policy: fullPolicy(assignment.policy),
    assignedAt: assignment.createdAt,
    events: eventNamesOf(assignment.events),
    senders: senderListOf(assignment.senders),
    subscriptions: subscriptionsOf(subscriptions, assignment.connector, assignment.agent),
  };
}

export function connectorView(row: ConnectorRow, assignments: AssignmentRow[], events: ConnectorEvents = NO_EVENTS): ConnectorView {
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
    events: (events.offered.get(row.id) ?? []).map(offeredView),
    agents: assignments.filter((a) => a.connector === row.id).map((a) => agentView(a, events.subscriptions)),
  };
}
