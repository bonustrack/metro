import { and, eq, getTableColumns, inArray, isNotNull, lt, or } from 'drizzle-orm';
import { isRecord } from '@metro-labs/core/is-record';
import { deliversMail, EMAIL_RECEIVED, type RemoteEvent } from '@metro-labs/http/mcp-events';
import { agentKeyColumns, type AgentKeyRow } from './agent-keys.js';
import type { Database } from './database.js';
import type { ConnectorRow } from './connectors.js';
import { agentKeys, agents, connectorAgents, connectors, connectorSubscriptions, connectorTools, mcpLeases } from './schema.js';

export type SubscriptionRow = typeof connectorSubscriptions.$inferSelect;

const ERROR_MAX = 1000;

export interface WantedSubscription {
  connector: ConnectorRow;
  identity: AgentKeyRow;
  event: string;
}

export interface Subscribed {
  serverId: string;
  cursor: string | null;
  refreshBefore: number | null;
  subscribedAt: number;
  signedIn: string;
}

export interface SubscriptionStore {
  wanted: () => Promise<WantedSubscription[]>;
  list: () => Promise<SubscriptionRow[]>;
  find: (id: string) => Promise<SubscriptionRow | null>;
  open: (row: SubscriptionRow) => Promise<SubscriptionRow>;
  subscribed: (id: string, done: Subscribed) => Promise<void>;
  failed: (id: string, error: string, at: number) => Promise<void>;
  ended: (id: string, error: string, at: number, signedOut?: string) => Promise<void>;
  cursor: (id: string, cursor: string | null) => Promise<void>;
  remove: (id: string) => Promise<void>;
  rekey: (id: string, secret: string) => Promise<void>;
  connectors: (ids: string[]) => Promise<Map<string, ConnectorRow>>;
  lease: (name: string, holder: string, now: number, ttlMs: number) => Promise<boolean>;
}

const isEvent = (value: unknown): value is RemoteEvent => isRecord(value) && typeof value.name === 'string' && Array.isArray(value.delivery);

function listedEvents(text: string | null): RemoteEvent[] {
  if (text === null) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter(isEvent) : [];
  } catch {
    return [];
  }
}

async function wanted(db: Database): Promise<WantedSubscription[]> {
  const rows = await db
    .select({ connector: getTableColumns(connectors), identity: agentKeyColumns, events: connectorTools.events })
    .from(connectorAgents)
    .innerJoin(connectors, eq(connectors.id, connectorAgents.connector))
    .innerJoin(agents, and(eq(agents.id, connectorAgents.agent), eq(agents.owner, connectors.owner), isNotNull(agents.host)))
    .innerJoin(agentKeys, and(eq(agentKeys.agent, agents.id), eq(agentKeys.owner, agents.owner)))
    .innerJoin(connectorTools, eq(connectorTools.connector, connectors.id))
    .orderBy(connectors.id, agents.id);
  return rows.filter((row) => deliversMail(listedEvents(row.events))).map((row) => ({ connector: row.connector, identity: row.identity, event: EMAIL_RECEIVED }));
}

async function open(db: Database, row: SubscriptionRow): Promise<SubscriptionRow> {
  const inserted = await db.insert(connectorSubscriptions).values(row).onConflictDoNothing().returning();
  if (inserted[0] !== undefined) return inserted[0];
  const key = and(eq(connectorSubscriptions.connector, row.connector), eq(connectorSubscriptions.agent, row.agent), eq(connectorSubscriptions.event, row.event));
  const held = await db.select().from(connectorSubscriptions).where(key);
  if (held[0] === undefined) throw new Error('The subscription row could not be kept.');
  return held[0];
}

async function lease(db: Database, name: string, holder: string, now: number, ttlMs: number): Promise<boolean> {
  const free = or(eq(mcpLeases.holder, holder), lt(mcpLeases.expiresAt, now));
  const taken = await db
    .insert(mcpLeases)
    .values({ name, holder, expiresAt: now + ttlMs })
    .onConflictDoUpdate({ target: mcpLeases.name, set: { holder, expiresAt: now + ttlMs }, setWhere: free })
    .returning({ holder: mcpLeases.holder });
  return taken[0]?.holder === holder;
}

const byId = (id: string) => eq(connectorSubscriptions.id, id);

export function subscriptionStore(db: () => Database): SubscriptionStore {
  return {
    wanted: () => wanted(db()),
    list: () => db().select().from(connectorSubscriptions).orderBy(connectorSubscriptions.id),
    find: async (id) => (await db().select().from(connectorSubscriptions).where(byId(id)).limit(1))[0] ?? null,
    open: (row) => open(db(), row),
    subscribed: async (id, done) => {
      await db().update(connectorSubscriptions).set({ ...done, error: null, errorAt: null }).where(byId(id));
    },
    failed: async (id, error, at) => {
      await db().update(connectorSubscriptions).set({ error: error.slice(0, ERROR_MAX), errorAt: at }).where(byId(id));
    },
    ended: async (id, error, at, signedOut) => {
      await db().update(connectorSubscriptions).set({ serverId: null, refreshBefore: null, error: error.slice(0, ERROR_MAX), errorAt: at, ...(signedOut === undefined ? {} : { signedIn: signedOut }) }).where(byId(id));
    },
    cursor: async (id, cursor) => {
      if (cursor === null) return;
      await db().update(connectorSubscriptions).set({ cursor }).where(byId(id));
    },
    remove: async (id) => {
      await db().delete(connectorSubscriptions).where(byId(id));
    },
    rekey: async (id, secret) => {
      await db().update(connectorSubscriptions).set({ secret }).where(byId(id));
    },
    connectors: async (ids) => {
      if (ids.length === 0) return new Map();
      const rows = await db().select().from(connectors).where(inArray(connectors.id, ids));
      return new Map(rows.map((row) => [row.id, row]));
    },
    lease: (name, holder, now, ttlMs) => lease(db(), name, holder, now, ttlMs),
  };
}
