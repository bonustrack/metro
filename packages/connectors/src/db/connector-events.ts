import { and, asc, eq, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from './database.js';
import { connectorAgents, connectorEvents, connectors, connectorSubscriptions } from './schema.js';

export const EVENT_KEEP_MS = 7 * 24 * 60 * 60_000;
export const EVENT_REDELIVER_MS = 60_000;
export const EVENTS_PER_POLL = 4;
export const EVENTS_WAITING_MAX = 1000;

export type EventRow = typeof connectorEvents.$inferSelect;

export type NewEvent = typeof connectorEvents.$inferInsert;

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
  receivedAt: number;
}

export interface EventStore {
  keep: (row: NewEvent) => Promise<boolean>;
  waiting: (identity: EventAgent) => Promise<number>;
  subscribed: (identity: EventAgent) => Promise<boolean>;
  due: (identity: EventAgent, now: number) => Promise<boolean>;
  claim: (identity: EventAgent, now: number) => Promise<EventRow[]>;
  settle: (identity: EventAgent, ids: string[]) => Promise<SettledEvent[]>;
  connectorNames: (owner: string, agent: string) => Promise<{ id: string; name: string }[]>;
}

const SETTLED = {
  id: connectorEvents.id,
  owner: connectorEvents.owner,
  agent: connectorEvents.agent,
  connector: connectorEvents.connector,
  event: connectorEvents.event,
  receivedAt: connectorEvents.receivedAt,
};

const waitingFor = (identity: EventAgent): SQL | undefined => and(eq(connectorEvents.agent, identity.agent), eq(connectorEvents.owner, identity.owner), isNotNull(connectorEvents.body));

const dueFor = (identity: EventAgent, now: number): SQL | undefined => and(waitingFor(identity), or(isNull(connectorEvents.deliveredAt), lt(connectorEvents.deliveredAt, now - EVENT_REDELIVER_MS)));

async function claim(db: Database, identity: EventAgent, now: number): Promise<EventRow[]> {
  const ids = db.select({ id: connectorEvents.id }).from(connectorEvents).where(dueFor(identity, now)).orderBy(asc(connectorEvents.seq)).limit(EVENTS_PER_POLL);
  const rows = await db.update(connectorEvents).set({ deliveredAt: now }).where(and(inArray(connectorEvents.id, ids), isNotNull(connectorEvents.body))).returning();
  return rows.sort((a, b) => a.seq - b.seq);
}

export async function pruneEvents(db: Database, now: number): Promise<{ expired: SettledEvent[]; removed: number }> {
  const gone = await db.delete(connectorEvents).where(lt(connectorEvents.receivedAt, now - EVENT_KEEP_MS)).returning({ ...SETTLED, waiting: sql<boolean>`${connectorEvents.body} is not null` });
  return { expired: gone.filter((row) => row.waiting), removed: gone.length };
}

export function eventStore(db: () => Database): EventStore {
  return {
    keep: async (row) => (await db().insert(connectorEvents).values(row).onConflictDoNothing().returning({ id: connectorEvents.id })).length > 0,
    waiting: (identity) => db().$count(connectorEvents, waitingFor(identity)),
    subscribed: async (identity) =>
      (await db().select({ id: connectorSubscriptions.id }).from(connectorSubscriptions).where(and(eq(connectorSubscriptions.agent, identity.agent), eq(connectorSubscriptions.owner, identity.owner))).limit(1)).length > 0,
    due: async (identity, now) => (await db().select({ id: connectorEvents.id }).from(connectorEvents).where(dueFor(identity, now)).limit(1)).length > 0,
    claim: (identity, now) => claim(db(), identity, now),
    settle: async (identity, ids) => {
      if (ids.length === 0) return [];
      return db().update(connectorEvents).set({ body: null }).where(and(waitingFor(identity), inArray(connectorEvents.id, ids))).returning(SETTLED);
    },
    connectorNames: (owner, agent) =>
      db()
        .select({ id: connectors.id, name: connectors.name })
        .from(connectorAgents)
        .innerJoin(connectors, and(eq(connectors.id, connectorAgents.connector), eq(connectors.owner, owner)))
        .where(eq(connectorAgents.agent, agent)),
  };
}
