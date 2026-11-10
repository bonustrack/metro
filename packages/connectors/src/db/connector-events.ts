import { and, asc, eq, inArray, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from './database.js';
import { connectorAgents, connectorEvents, connectors, connectorSubscriptions } from './schema.js';

export const EVENT_KEEP_MS = 7 * 24 * 60 * 60_000;
export const EVENT_REDELIVER_MS = 60_000;
export const EVENTS_PER_POLL = 4;

export type EventRow = typeof connectorEvents.$inferSelect;

export type EventKind = 'event' | 'gap';

interface EventAgent {
  agent: string;
  owner: string;
}

export interface SettledEvent {
  id: string;
  owner: string;
  agent: string;
  connector: string;
  event: string;
  kind: string;
  receivedAt: number;
}

export interface EventStore {
  keep: (row: EventRow) => Promise<boolean>;
  subscribed: (identity: EventAgent) => Promise<boolean>;
  due: (identity: EventAgent, now: number) => Promise<boolean>;
  claim: (identity: EventAgent, now: number) => Promise<EventRow[]>;
  settle: (identity: EventAgent, ids: string[], state: 'delivered' | 'dropped', now: number) => Promise<SettledEvent[]>;
  connectorNames: (owner: string, agent: string) => Promise<{ id: string; name: string }[]>;
}

const SETTLED = {
  id: connectorEvents.id,
  owner: connectorEvents.owner,
  agent: connectorEvents.agent,
  connector: connectorEvents.connector,
  event: connectorEvents.event,
  kind: connectorEvents.kind,
  receivedAt: connectorEvents.receivedAt,
};

const mine = (identity: EventAgent): SQL | undefined => and(eq(connectorEvents.agent, identity.agent), eq(connectorEvents.owner, identity.owner));

const dueFor = (identity: EventAgent, now: number): SQL | undefined =>
  and(mine(identity), eq(connectorEvents.state, 'waiting'), or(isNull(connectorEvents.deliveredAt), lt(connectorEvents.deliveredAt, now - EVENT_REDELIVER_MS)));

async function claim(db: Database, identity: EventAgent, now: number): Promise<EventRow[]> {
  const ids = db.select({ id: connectorEvents.id }).from(connectorEvents).where(dueFor(identity, now)).orderBy(asc(connectorEvents.receivedAt), asc(connectorEvents.id)).limit(EVENTS_PER_POLL);
  const rows = await db.update(connectorEvents).set({ deliveredAt: now }).where(and(inArray(connectorEvents.id, ids), eq(connectorEvents.state, 'waiting'))).returning();
  return rows.sort((a, b) => a.receivedAt - b.receivedAt || (a.id < b.id ? -1 : 1));
}

export function expireEvents(db: Database, now: number): Promise<SettledEvent[]> {
  return db
    .update(connectorEvents)
    .set({ state: 'expired', body: null, settledAt: now })
    .where(and(eq(connectorEvents.state, 'waiting'), lt(connectorEvents.receivedAt, now - EVENT_KEEP_MS)))
    .returning(SETTLED);
}

export async function pruneEvents(db: Database, now: number): Promise<number> {
  const lastChange = sql<number>`coalesce(${connectorEvents.settledAt}, ${connectorEvents.receivedAt})`;
  return (await db.delete(connectorEvents).where(and(ne(connectorEvents.state, 'waiting'), lt(lastChange, now - EVENT_KEEP_MS))).returning({ id: connectorEvents.id })).length;
}

export function eventStore(db: () => Database): EventStore {
  return {
    keep: async (row) => (await db().insert(connectorEvents).values(row).onConflictDoNothing().returning({ id: connectorEvents.id })).length > 0,
    subscribed: async (identity) =>
      (await db().select({ id: connectorSubscriptions.id }).from(connectorSubscriptions).where(and(eq(connectorSubscriptions.agent, identity.agent), eq(connectorSubscriptions.owner, identity.owner))).limit(1)).length > 0,
    due: async (identity, now) => (await db().select({ id: connectorEvents.id }).from(connectorEvents).where(dueFor(identity, now)).limit(1)).length > 0,
    claim: (identity, now) => claim(db(), identity, now),
    settle: async (identity, ids, state, now) => {
      if (ids.length === 0) return [];
      return db()
        .update(connectorEvents)
        .set({ state, body: null, settledAt: now })
        .where(and(mine(identity), inArray(connectorEvents.id, ids), eq(connectorEvents.state, 'waiting')))
        .returning(SETTLED);
    },
    connectorNames: (owner, agent) =>
      db()
        .select({ id: connectors.id, name: connectors.name })
        .from(connectorAgents)
        .innerJoin(connectors, and(eq(connectors.id, connectorAgents.connector), eq(connectors.owner, owner)))
        .where(eq(connectorAgents.agent, agent)),
  };
}
