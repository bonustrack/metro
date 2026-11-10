import { and, eq, getTableColumns, isNotNull, lte, ne, sql } from 'drizzle-orm';
import { EVENT_NAME_RE } from '@metro-labs/http/mcp-events';
import type { ConnectorRow } from './connectors.js';
import type { Database } from './database.js';
import { agents, connectorAgents, connectors, connectorSubscriptions } from './schema.js';

export type SubscriptionRow = typeof connectorSubscriptions.$inferSelect;

export type SubscriptionStatus = 'pending' | 'active' | 'signed_out' | 'error';

export type SubscriptionChange = Partial<Pick<SubscriptionRow, 'secret' | 'serverId' | 'cursor' | 'sender' | 'status' | 'error' | 'failures' | 'signedIn' | 'subscribedAt' | 'refreshBefore' | 'nextAt'>>;

export interface WantedEvents {
  connector: ConnectorRow;
  agent: string;
  events: string[];
}

export interface Receiver {
  subscription: SubscriptionRow;
  wanted: string | null;
  senders: string | null;
}

export interface SubscriptionStore {
  wanted: () => Promise<WantedEvents[]>;
  rows: () => Promise<SubscriptionRow[]>;
  find: (id: string) => Promise<SubscriptionRow | null>;
  receiver: (id: string) => Promise<Receiver | null>;
  open: (row: SubscriptionRow) => Promise<void>;
  claim: (id: string, now: number, ms: number) => Promise<SubscriptionRow | null>;
  update: (id: string, change: SubscriptionChange) => Promise<void>;
  release: (id: string, change: SubscriptionChange) => Promise<void>;
  keepCursor: (id: string, cursor: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  connector: (id: string) => Promise<ConnectorRow | null>;
}

const ERROR_MAX = 1000;
const EVENTS_MAX = 50;
const NO_EVENTS = '[]';

export function eventNamesOf(text: string | null): string[] {
  try {
    const parsed: unknown = text === null ? [] : JSON.parse(text);
    const names = Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === 'string' && EVENT_NAME_RE.test(name)) : [];
    return [...new Set(names)].slice(0, EVENTS_MAX);
  } catch {
    return [];
  }
}

const box = and(eq(agents.kind, 'box'), isNotNull(agents.host));

async function wanted(db: Database): Promise<WantedEvents[]> {
  const rows = await db
    .select({ connector: getTableColumns(connectors), agent: connectorAgents.agent, events: connectorAgents.events })
    .from(connectorAgents)
    .innerJoin(connectors, eq(connectors.id, connectorAgents.connector))
    .innerJoin(agents, and(eq(agents.id, connectorAgents.agent), eq(agents.owner, connectors.owner), box))
    .where(ne(connectorAgents.events, NO_EVENTS))
    .orderBy(connectors.id, connectorAgents.agent);
  return rows.map((row) => ({ connector: row.connector, agent: row.agent, events: eventNamesOf(row.events) })).filter((row) => row.events.length > 0);
}

async function receiver(db: Database, id: string): Promise<Receiver | null> {
  const rows = await db
    .select({ subscription: getTableColumns(connectorSubscriptions), wanted: connectorAgents.events, senders: connectorAgents.senders })
    .from(connectorSubscriptions)
    .leftJoin(agents, and(eq(agents.id, connectorSubscriptions.agent), eq(agents.owner, connectorSubscriptions.owner), box))
    .leftJoin(connectorAgents, and(eq(connectorAgents.connector, connectorSubscriptions.connector), eq(connectorAgents.agent, agents.id)))
    .where(eq(connectorSubscriptions.id, id))
    .limit(1);
  return rows[0] ?? null;
}

const byId = (id: string) => eq(connectorSubscriptions.id, id);

const capped = (change: SubscriptionChange): SubscriptionChange => (typeof change.error === 'string' ? { ...change, error: change.error.slice(0, ERROR_MAX) } : change);

export function subscriptionStore(db: () => Database): SubscriptionStore {
  return {
    wanted: () => wanted(db()),
    rows: () => db().select().from(connectorSubscriptions).orderBy(connectorSubscriptions.nextAt, connectorSubscriptions.id),
    find: async (id) => (await db().select().from(connectorSubscriptions).where(byId(id)).limit(1))[0] ?? null,
    receiver: (id) => receiver(db(), id),
    open: async (row) => {
      await db().insert(connectorSubscriptions).values(row).onConflictDoNothing();
    },
    claim: async (id, now, ms) => (await db().update(connectorSubscriptions).set({ claimedUntil: now + ms }).where(and(byId(id), lte(connectorSubscriptions.claimedUntil, now))).returning())[0] ?? null,
    update: async (id, change) => {
      if (Object.keys(change).length > 0) await db().update(connectorSubscriptions).set(capped(change)).where(byId(id));
    },
    release: async (id, change) => {
      await db().update(connectorSubscriptions).set({ ...capped(change), claimedUntil: 0 }).where(byId(id));
    },
    keepCursor: async (id, cursor) => {
      await db().update(connectorSubscriptions).set({ cursor }).where(and(byId(id), sql`${connectorSubscriptions.cursor} is distinct from ${cursor}`));
    },
    remove: async (id) => {
      await db().delete(connectorSubscriptions).where(byId(id));
    },
    connector: async (id) => (await db().select().from(connectors).where(eq(connectors.id, id)).limit(1))[0] ?? null,
  };
}
