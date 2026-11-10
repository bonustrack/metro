import { newId } from '@metro-labs/core/ids';
import { errMsg, log } from '@metro-labs/core/log';
import { mailSenderVerdict, sendersOf } from '@metro-labs/http/mail-senders';
import { EMAIL_RECEIVED, emailReceivedOf, type EmailReceived } from '@metro-labs/http/mcp-events';
import type { MailTaken, McpMail } from '@metro-labs/http/mcp-server-protocol';
import { connectorKeys } from '@metro-labs/connectors/connector-keys';
import type { InboxRow, MailAssignment, SettledMail, WaitingMail } from '@metro-labs/connectors/db/connector-inbox';
import type { SubscriptionRow } from '@metro-labs/connectors/db/connector-subscriptions';
import { openSecret, sealSecret } from '@metro-labs/connectors/secrets';
import type { McpDeps } from './deps.js';

export type ReceivedOutcome = 'delivered' | 'dropped_sender' | 'dropped_unverified' | 'dropped_off' | 'dropped_paused' | 'expired';

export type Received = 'kept' | 'dropped' | 'duplicate' | 'unassigned';

type MailDeps = Pick<McpDeps, 'key' | 'inbox' | 'calls' | 'waiters' | 'now'>;

interface InboxAgent {
  owner: string;
  agent: string;
}

interface Named {
  key: string;
  name: string | null;
}

function gate(assignment: MailAssignment, mail: EmailReceived): ReceivedOutcome | null {
  if (!assignment.receive) return 'dropped_off';
  const verdict = mailSenderVerdict(sendersOf(assignment.senders), mail.from.address, mail.senderVerified);
  if (verdict === 'sender') return 'dropped_sender';
  return verdict === 'unverified' ? 'dropped_unverified' : null;
}

async function namesFor(deps: Pick<McpDeps, 'inbox'>, identity: InboxAgent, extra: string[] = []): Promise<Map<string, Named>> {
  const rows = await deps.inbox.connectorNames(identity.owner, identity.agent);
  const keys = connectorKeys(rows);
  const names = new Map<string, Named>(rows.map((row) => [row.id, { key: keys.get(row.id) ?? row.id, name: row.name }]));
  for (const id of extra) if (!names.has(id)) names.set(id, { key: id, name: null });
  return names;
}

async function record(deps: MailDeps, settled: Pick<SettledMail, 'owner' | 'agent' | 'connector'>, outcome: ReceivedOutcome, ms: number): Promise<void> {
  const named = (await namesFor(deps, settled, [settled.connector])).get(settled.connector);
  deps.calls.record(settled, { kind: 'received', connector: settled.connector, connectorKey: named?.key ?? settled.connector, connectorName: named?.name ?? null, tool: EMAIL_RECEIVED, outcome, ms, at: deps.now() });
}

export function recordQuietly(deps: MailDeps, settled: Pick<SettledMail, 'owner' | 'agent' | 'connector'>, outcome: ReceivedOutcome, ms: number): void {
  record(deps, settled, outcome, ms).catch((err: unknown) => {
    log.warn({ agent: settled.agent, connector: settled.connector, err: errMsg(err) }, 'mcp: could not record a received mail');
  });
}

export async function receiveMail(deps: MailDeps, sub: SubscriptionRow, eventId: string, mail: EmailReceived): Promise<Received> {
  const assignment = await deps.inbox.assignment(sub.owner, sub.connector, sub.agent);
  if (assignment === null) return 'unassigned';
  const dropped = gate(assignment, mail);
  const now = deps.now();
  const id = newId();
  const row: InboxRow = {
    id,
    owner: sub.owner,
    connector: sub.connector,
    agent: sub.agent,
    eventId,
    state: dropped === null ? 'waiting' : 'dropped',
    mail: dropped === null ? sealSecret(deps.key, sub.owner, id, mail, 'mail') : null,
    receivedAt: now,
    deliveredAt: null,
    takenAt: dropped === null ? null : now,
  };
  if (!(await deps.inbox.keep(row))) return 'duplicate';
  if (dropped === null) {
    deps.waiters.ring(sub.agent);
    log.info({ agent: sub.agent, connector: sub.connector, inbox: id }, 'mcp: a mail is waiting for the box');
    return 'kept';
  }
  recordQuietly(deps, sub, dropped, 0);
  log.info({ agent: sub.agent, connector: sub.connector, outcome: dropped }, 'mcp: a mail was dropped by the agent\'s settings');
  return 'dropped';
}

function opened(deps: Pick<McpDeps, 'key'>, owner: string, row: WaitingMail): EmailReceived | null {
  try {
    return emailReceivedOf(openSecret(deps.key, owner, row.id, row.mail, 'mail'));
  } catch (err) {
    log.warn({ inbox: row.id, err: errMsg(err) }, 'mcp: a waiting mail could not be opened');
    return null;
  }
}

export async function waitingMail(deps: Pick<McpDeps, 'key' | 'inbox' | 'now'>, identity: InboxAgent): Promise<McpMail[]> {
  if (!(await deps.inbox.due(identity, deps.now()))) return [];
  const rows = await deps.inbox.deliver(identity, deps.now());
  if (rows.length === 0) return [];
  const names = await namesFor(deps, identity, rows.map((row) => row.connector));
  return rows.flatMap((row) => {
    const mail = opened(deps, identity.owner, row);
    const named = names.get(row.connector);
    return mail === null || named === undefined ? [] : [{ ...mail, id: row.id, connector: row.connector, key: named.key, name: named.name ?? named.key }];
  });
}

export async function takeMail(deps: MailDeps, identity: InboxAgent, taken: MailTaken[]): Promise<number> {
  const now = deps.now();
  let count = 0;
  for (const outcome of ['delivered', 'paused'] as const) {
    const ids = taken.filter((row) => row.outcome === outcome).map((row) => row.id);
    const settled = await deps.inbox.take(identity, ids, outcome === 'delivered' ? 'delivered' : 'dropped', now);
    for (const row of settled) recordQuietly(deps, row, outcome === 'delivered' ? 'delivered' : 'dropped_paused', now - row.receivedAt);
    count += settled.length;
  }
  if (count > 0) log.info({ agent: identity.agent, taken: count }, 'mcp: the box took its mail');
  return count;
}
