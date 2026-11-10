import { newId } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import { eventSenderOf, type EventSender, type SenderPointers, type WebhookBody } from '@metro-labs/http/mcp-events';
import type { McpConnectorEvent, McpSettled } from '@metro-labs/http/mcp-server-protocol';
import { senderListOf, senderVerdict } from '@metro-labs/http/sender-list';
import type { AgentKeyRow } from '@metro-labs/connectors/db/agent-keys';
import { EVENTS_WAITING_MAX, type EventRow } from '@metro-labs/connectors/db/connector-events';
import type { Receiver } from '@metro-labs/connectors/db/connector-subscriptions';
import { failureText } from '@metro-labs/connectors/db/errors';
import { connectorKeys } from '@metro-labs/connectors/connector-keys';
import { openSecret, sealSecret } from '@metro-labs/connectors/secrets';
import { agentConnectors } from './catalog.js';
import type { McpDeps } from './deps.js';

type EventOutcome = 'delivered' | 'skipped' | 'dropped_sender' | 'dropped_unverified' | 'dropped_paused' | 'dropped_unassigned' | 'expired';

type EventDeps = Pick<McpDeps, 'key' | 'events' | 'calls' | 'waiters' | 'now'>;

interface Owned {
  owner: string;
  agent: string;
  connector: string;
  event: string;
}

type Kept = Pick<McpConnectorEvent, 'timestamp' | 'data' | 'sender' | 'senderVerified'>;

type OccurredEvent = Extract<WebhookBody, { kind: 'event' }>;

export const inboxWaiter = (agent: string): string => `inbox ${agent}`;

function senderPointersIn(text: string | null): SenderPointers | null {
  const parsed: unknown = text === null ? null : JSON.parse(text);
  if (!isRecord(parsed) || typeof parsed.id !== 'string') return null;
  return typeof parsed.verified === 'string' ? { id: parsed.id, verified: parsed.verified } : { id: parsed.id };
}

async function record(deps: Pick<McpDeps, 'events' | 'calls' | 'now'>, row: Owned, outcome: EventOutcome, ms: number): Promise<void> {
  const assigned = await deps.events.connectorNames(row.owner, row.agent);
  const name = assigned.find((connector) => connector.id === row.connector)?.name ?? null;
  deps.calls.record(row, { kind: 'event', connector: row.connector, connectorKey: connectorKeys(assigned).get(row.connector) ?? row.connector, connectorName: name, tool: row.event, outcome, ms, at: deps.now() });
}

export function recordEvent(deps: Pick<McpDeps, 'events' | 'calls' | 'now'>, row: Owned, outcome: EventOutcome, ms: number): void {
  record(deps, row, outcome, ms).catch((err: unknown) => {
    log.warn({ agent: row.agent, connector: row.connector, err: failureText(err) }, 'mcp: could not record a connector event');
  });
}

const keptOf = (event: OccurredEvent, sender: EventSender | null): Kept => ({
  timestamp: event.timestamp,
  data: event.data,
  ...(sender === null || sender.id === null ? {} : { sender: sender.id }),
  ...(sender?.verified === undefined ? {} : { senderVerified: sender.verified }),
});

export async function receiveEvent(deps: EventDeps, receiver: Receiver, event: OccurredEvent): Promise<'kept' | 'dropped' | 'duplicate' | 'full'> {
  const sub = receiver.subscription;
  const sender = eventSenderOf(senderPointersIn(sub.sender), event.data);
  const verdict = senderVerdict(senderListOf(receiver.senders), sender);
  if (verdict === 'allow' && (await deps.events.waiting(sub)) >= EVENTS_WAITING_MAX) return 'full';
  const id = newId();
  const body = verdict === 'allow' ? sealSecret(deps.key, sub.owner, id, keptOf(event, sender), 'event') : null;
  if (!(await deps.events.keep({ id, owner: sub.owner, connector: sub.connector, agent: sub.agent, subscription: sub.id, event: sub.event, eventId: event.eventId, body, receivedAt: deps.now() }))) return 'duplicate';
  if (verdict === 'allow') {
    deps.waiters.notify(inboxWaiter(sub.agent));
    log.info({ agent: sub.agent, connector: sub.connector, event: id }, 'mcp: a connector event waits for the agent');
    return 'kept';
  }
  recordEvent(deps, sub, verdict === 'not_verified' ? 'dropped_unverified' : 'dropped_sender', 0);
  log.info({ agent: sub.agent, connector: sub.connector, verdict }, 'mcp: a connector event was dropped by who can write');
  return 'dropped';
}

function opened(deps: Pick<McpDeps, 'key'>, row: EventRow): Kept | null {
  try {
    const body = row.body === null ? null : openSecret(deps.key, row.owner, row.id, row.body, 'event');
    if (!isRecord(body) || typeof body.timestamp !== 'string' || !isRecord(body.data)) return null;
    return { timestamp: body.timestamp, data: body.data, ...(typeof body.sender === 'string' ? { sender: body.sender } : {}), ...(typeof body.senderVerified === 'boolean' ? { senderVerified: body.senderVerified } : {}) };
  } catch {
    log.warn({ event: row.id }, 'mcp: a waiting connector event could not be opened');
    return null;
  }
}

export async function waitingEvents(deps: EventDeps & Pick<McpDeps, 'store'>, identity: AgentKeyRow): Promise<McpConnectorEvent[]> {
  const now = deps.now();
  if (!(await deps.events.due(identity, now))) return [];
  const rows = await deps.events.claim(identity, now);
  if (rows.length === 0) return [];
  const connectors = new Map((await agentConnectors(deps, identity)).map((connector) => [connector.id, { id: connector.id, key: connector.key, name: connector.name }]));
  const out: McpConnectorEvent[] = [];
  const unusable: string[] = [];
  for (const row of rows) {
    const connector = connectors.get(row.connector);
    const kept = connector === undefined ? null : opened(deps, row);
    if (connector === undefined || kept === null) unusable.push(row.id);
    else out.push({ id: row.id, connector, event: row.event, eventId: row.eventId, ...kept });
  }
  for (const row of await deps.events.settle(identity, unusable)) if (!connectors.has(row.connector)) recordEvent(deps, row, 'dropped_unassigned', 0);
  return out;
}

export async function settleEvents(deps: EventDeps, identity: AgentKeyRow, settled: McpSettled[]): Promise<void> {
  for (const outcome of ['delivered', 'paused'] as const) {
    const rows = await deps.events.settle(identity, settled.filter((entry) => entry.outcome === outcome).map((entry) => entry.id));
    for (const row of rows) recordEvent(deps, row, outcome === 'delivered' ? 'delivered' : 'dropped_paused', deps.now() - row.receivedAt);
  }
}
