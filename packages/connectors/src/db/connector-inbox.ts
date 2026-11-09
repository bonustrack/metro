import { and, asc, eq, exists, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { Database } from './database.js';
import { agents, connectorAgents, connectorInbox, connectors } from './schema.js';

export const MAIL_KEEP_MS = 7 * 24 * 60 * 60_000;
export const MAIL_REDELIVER_MS = 60_000;
export const MAIL_PER_POLL = 10;

export type InboxRow = typeof connectorInbox.$inferSelect;

interface InboxAgent {
  agent: string;
  owner: string;
}

export interface MailAssignment {
  senders: string | null;
  receive: boolean;
}

export interface WaitingMail {
  id: string;
  connector: string;
  mail: string;
  receivedAt: number;
}

export interface SettledMail {
  id: string;
  owner: string;
  agent: string;
  connector: string;
  receivedAt: number;
}

export interface InboxStore {
  assignment: (owner: string, connector: string, agent: string) => Promise<MailAssignment | null>;
  connectorNames: (owner: string, agent: string) => Promise<{ id: string; name: string }[]>;
  keep: (row: InboxRow) => Promise<boolean>;
  deliver: (identity: InboxAgent, now: number) => Promise<WaitingMail[]>;
  take: (identity: InboxAgent, ids: string[], state: 'delivered' | 'dropped', now: number) => Promise<SettledMail[]>;
}

const mine = (identity: InboxAgent) => and(eq(connectorInbox.agent, identity.agent), eq(connectorInbox.owner, identity.owner));

async function assignment(db: Database, owner: string, connector: string, agent: string): Promise<MailAssignment | null> {
  const rows = await db
    .select({ senders: connectorAgents.senders, receive: connectorAgents.receive })
    .from(connectorAgents)
    .innerJoin(connectors, and(eq(connectors.id, connectorAgents.connector), eq(connectors.owner, owner)))
    .innerJoin(agents, and(eq(agents.id, connectorAgents.agent), eq(agents.owner, owner)))
    .where(and(eq(connectorAgents.connector, connector), eq(connectorAgents.agent, agent)))
    .limit(1);
  return rows[0] ?? null;
}

function connectorNames(db: Database, owner: string, agent: string): Promise<{ id: string; name: string }[]> {
  return db
    .select({ id: connectors.id, name: connectors.name })
    .from(connectorAgents)
    .innerJoin(connectors, and(eq(connectors.id, connectorAgents.connector), eq(connectors.owner, owner)))
    .innerJoin(agents, and(eq(agents.id, connectorAgents.agent), eq(agents.owner, owner)))
    .where(eq(connectorAgents.agent, agent));
}

async function keep(db: Database, row: InboxRow): Promise<boolean> {
  const inserted = await db.insert(connectorInbox).values(row).onConflictDoNothing().returning({ id: connectorInbox.id });
  return inserted.length > 0;
}

async function deliver(db: Database, identity: InboxAgent, now: number): Promise<WaitingMail[]> {
  const assigned = exists(db.select({ one: sql`1` }).from(connectorAgents).where(and(eq(connectorAgents.connector, connectorInbox.connector), eq(connectorAgents.agent, connectorInbox.agent))));
  const due = and(mine(identity), eq(connectorInbox.state, 'waiting'), or(isNull(connectorInbox.deliveredAt), lt(connectorInbox.deliveredAt, now - MAIL_REDELIVER_MS)), assigned);
  const ids = db.select({ id: connectorInbox.id }).from(connectorInbox).where(due).orderBy(asc(connectorInbox.receivedAt), asc(connectorInbox.id)).limit(MAIL_PER_POLL);
  const rows = await db.update(connectorInbox).set({ deliveredAt: now }).where(and(inArray(connectorInbox.id, ids), eq(connectorInbox.state, 'waiting'))).returning();
  return rows
    .flatMap((row) => (row.mail === null ? [] : [{ id: row.id, connector: row.connector, mail: row.mail, receivedAt: row.receivedAt }]))
    .sort((a, b) => a.receivedAt - b.receivedAt || (a.id < b.id ? -1 : 1));
}

async function take(db: Database, identity: InboxAgent, ids: string[], state: 'delivered' | 'dropped', now: number): Promise<SettledMail[]> {
  if (ids.length === 0) return [];
  return db
    .update(connectorInbox)
    .set({ state, mail: null, takenAt: now })
    .where(and(mine(identity), inArray(connectorInbox.id, ids), eq(connectorInbox.state, 'waiting')))
    .returning({ id: connectorInbox.id, owner: connectorInbox.owner, agent: connectorInbox.agent, connector: connectorInbox.connector, receivedAt: connectorInbox.receivedAt });
}

export async function expireMail(db: Database, now: number): Promise<SettledMail[]> {
  return db
    .update(connectorInbox)
    .set({ state: 'expired', mail: null, takenAt: now })
    .where(and(eq(connectorInbox.state, 'waiting'), lt(connectorInbox.receivedAt, now - MAIL_KEEP_MS)))
    .returning({ id: connectorInbox.id, owner: connectorInbox.owner, agent: connectorInbox.agent, connector: connectorInbox.connector, receivedAt: connectorInbox.receivedAt });
}

export async function pruneInbox(db: Database, now: number): Promise<number> {
  const lastChange = sql<number>`coalesce(${connectorInbox.takenAt}, ${connectorInbox.receivedAt})`;
  const removed = await db.delete(connectorInbox).where(and(ne(connectorInbox.state, 'waiting'), lt(lastChange, now - MAIL_KEEP_MS))).returning({ id: connectorInbox.id });
  return removed.length;
}

export function inboxStore(db: () => Database): InboxStore {
  return {
    assignment: (owner, connector, agent) => assignment(db(), owner, connector, agent),
    connectorNames: (owner, agent) => connectorNames(db(), owner, agent),
    keep: (row) => keep(db(), row),
    deliver: (identity, now) => deliver(db(), identity, now),
    take: (identity, ids, state, now) => take(db(), identity, ids, state, now),
  };
}
