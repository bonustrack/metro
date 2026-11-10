import { newId } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';
import { eventSenderOf, type EventSender, type SenderPointers, type WebhookBody } from '@metro-labs/http/mcp-events';
import type { McpConnectorEvent, McpSettled } from '@metro-labs/http/mcp-server-protocol';
import { senderListOf, senderVerdict } from '@metro-labs/http/sender-list';
import type { AgentKeyRow } from '@metro-labs/connectors/db/agent-keys';
import type { EventRow, SettledEvent } from '@metro-labs/connectors/db/connector-events';
import type { Receiver, SubscriptionRow } from '@metro-labs/connectors/db/connector-subscriptions';
import { connectorKeys } from '@metro-labs/connectors/connector-keys';
import { openSecret, sealSecret } from '@metro-labs/connectors/secrets';
import { agentConnectors } from './catalog.js';
import type { McpDeps } from './deps.js';

export type EventOutcome = 'delivered' | 'skipped' | 'dropped_sender' | 'dropped_unverified' | 'dropped_paused' | 'dropped_unassigned' | 'expired';

type EventDeps = Pick<McpDeps, 'key' | 'events' | 'subscriptions' | 'calls' | 'waiters' | 'now'>;

interface Owned {
  owner: string;
  agent: string;
  connector: string;
  event: string;
}

interface SealedBody {
  timestamp: string;
  data?: Record<string, unknown>;
  sender?: string;
  verified?: boolean;
}

type OccurredEvent = Extract<WebhookBody, { kind: 'event' }>;

export const inboxWaiter = (agent: string): string => `inbox ${agent}`;

export function senderPointersIn(text: string | null): SenderPointers | null {
  try {
    const parsed: unknown = text === null ? null : JSON.parse(text);
    if (!isRecord(parsed) || typeof parsed.id !== 'string') return null;
    return typeof parsed.verified === 'string' ? { id: parsed.id, verified: parsed.verified } : { id: parsed.id };
  } catch {
    return null;
  }
}

async function namedConnector(deps: Pick<McpDeps, 'events' | 'subscriptions'>, row: Owned): Promise<{ key: string; name: string | null }> {
  const assigned = await deps.events.connectorNames(row.owner, row.agent);
  const key = connectorKeys(assigned).get(row.connector);
  if (key !== undefined) return { key, name: assigned.find((connector) => connector.id === row.connector)?.name ?? null };
  return { key: row.connector, name: (await deps.subscriptions.connector(row.connector))?.name ?? null };
}

export function recordEvent(deps: Pick<McpDeps, 'events' | 'subscriptions' | 'calls' | 'now'>, row: Owned, outcome: EventOutcome, ms: number): void {
  namedConnector(deps, row)
    .then((named) => {
      deps.calls.record(row, { kind: 'event', connector: row.connector, connectorKey: named.key, connectorName: named.name, tool: row.event, outcome, ms, at: deps.now() });
    })
    .catch((err: unknown) => {
      log.warn({ agent: row.agent, connector: row.connector, err: errMsg(err) }, 'mcp: could not record a connector event');
    });
}

function sealedBody(sender: EventSender | null, event: OccurredEvent): SealedBody {
  return {
    timestamp: event.timestamp,
    data: event.data,
    ...(sender === null || sender.id === null ? {} : { sender: sender.id }),
    ...(sender?.verified === undefined ? {} : { verified: sender.verified }),
  };
}

function newRow(deps: Pick<McpDeps, 'key' | 'now'>, sub: SubscriptionRow, eventId: string, kind: 'event' | 'gap', body: SealedBody | null): EventRow {
  const id = newId();
  const now = deps.now();
  return {
    id,
    owner: sub.owner,
    connector: sub.connector,
    agent: sub.agent,
    subscription: sub.id,
    event: sub.event,
    eventId,
    kind,
    state: body === null ? 'dropped' : 'waiting',
    body: body === null ? null : sealSecret(deps.key, sub.owner, id, body, 'event'),
    receivedAt: now,
    deliveredAt: null,
    settledAt: body === null ? now : null,
  };
}

export async function receiveEvent(deps: EventDeps, receiver: Receiver, event: OccurredEvent): Promise<'kept' | 'dropped' | 'duplicate'> {
  const sub = receiver.subscription;
  const sender = eventSenderOf(senderPointersIn(sub.sender), event.data);
  const verdict = senderVerdict(senderListOf(receiver.senders), sender);
  const row = newRow(deps, sub, event.eventId, 'event', verdict === 'allow' ? sealedBody(sender, event) : null);
  if (!(await deps.events.keep(row))) return 'duplicate';
  if (verdict === 'allow') {
    deps.waiters.notify(inboxWaiter(sub.agent));
    log.info({ agent: sub.agent, connector: sub.connector, event: row.id }, 'mcp: a connector event waits for the agent');
    return 'kept';
  }
  recordEvent(deps, sub, verdict === 'not_verified' ? 'dropped_unverified' : 'dropped_sender', 0);
  log.info({ agent: sub.agent, connector: sub.connector, verdict }, 'mcp: a connector event was dropped by who can write');
  return 'dropped';
}

export async function receiveGap(deps: EventDeps, sub: SubscriptionRow, mark: string): Promise<void> {
  const kept = await deps.events.keep(newRow(deps, sub, `gap ${mark}`, 'gap', { timestamp: new Date(deps.now()).toISOString() }));
  if (kept) deps.waiters.notify(inboxWaiter(sub.agent));
}

function opened(deps: Pick<McpDeps, 'key'>, row: EventRow): SealedBody | null {
  try {
    const body = row.body === null ? null : openSecret(deps.key, row.owner, row.id, row.body, 'event');
    return isRecord(body) && typeof body.timestamp === 'string' ? { timestamp: body.timestamp, ...(isRecord(body.data) ? { data: body.data } : {}), ...(typeof body.sender === 'string' ? { sender: body.sender } : {}), ...(typeof body.verified === 'boolean' ? { verified: body.verified } : {}) } : null;
  } catch (err) {
    log.warn({ event: row.id, err: errMsg(err) }, 'mcp: a waiting connector event could not be opened');
    return null;
  }
}

function wireOf(row: EventRow, body: SealedBody, connector: { id: string; key: string; name: string }): McpConnectorEvent | null {
  const base = { id: row.id, connector, event: row.event, timestamp: body.timestamp };
  if (row.kind === 'gap') return { ...base, kind: 'gap' };
  if (body.data === undefined) return null;
  return { ...base, kind: 'event', eventId: row.eventId, data: body.data, ...(body.sender === undefined ? {} : { sender: body.sender }), ...(body.verified === undefined ? {} : { senderVerified: body.verified }) };
}

export async function waitingEvents(deps: EventDeps & Pick<McpDeps, 'store'>, identity: AgentKeyRow): Promise<McpConnectorEvent[]> {
  const now = deps.now();
  if (!(await deps.events.due(identity, now))) return [];
  const rows = await deps.events.claim(identity, now);
  if (rows.length === 0) return [];
  const connectors = new Map((await agentConnectors(deps, identity)).map((connector) => [connector.id, { id: connector.id, key: connector.key, name: connector.name }]));
  const out: McpConnectorEvent[] = [];
  const unusable: EventRow[] = [];
  for (const row of rows) {
    const connector = connectors.get(row.connector);
    const body = opened(deps, row);
    const wire = connector === undefined || body === null ? null : wireOf(row, body, connector);
    if (wire === null) unusable.push(row);
    else out.push(wire);
  }
  const dropped = await deps.events.settle(identity, unusable.map((row) => row.id), 'dropped', now);
  for (const row of dropped) if (!connectors.has(row.connector)) recordEvent(deps, row, 'dropped_unassigned', 0);
  return out;
}

const settledOutcome = (row: SettledEvent, outcome: McpSettled['outcome']): EventOutcome => {
  if (outcome === 'paused') return 'dropped_paused';
  return row.kind === 'gap' ? 'skipped' : 'delivered';
};

export async function settleEvents(deps: EventDeps, identity: AgentKeyRow, settled: McpSettled[]): Promise<number> {
  const now = deps.now();
  let count = 0;
  for (const outcome of ['delivered', 'paused'] as const) {
    const ids = settled.filter((entry) => entry.outcome === outcome).map((entry) => entry.id);
    const rows = await deps.events.settle(identity, ids, outcome === 'delivered' ? 'delivered' : 'dropped', now);
    for (const row of rows) recordEvent(deps, row, settledOutcome(row, outcome), now - row.receivedAt);
    count += rows.length;
  }
  if (count > 0) log.info({ agent: identity.agent, settled: count }, 'mcp: the agent took its connector events');
  return count;
}
