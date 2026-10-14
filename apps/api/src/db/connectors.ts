import { and, eq, type SQL } from 'drizzle-orm';
import { ApiError } from '@metro-labs/http/api-error';
import type { Database } from './client.js';
import { isUniqueViolation } from './errors.js';
import { agents, connectorAgents, connectors } from './schema.js';

export type ConnectorRow = typeof connectors.$inferSelect;
export type AssignmentRow = typeof connectorAgents.$inferSelect;

export interface ConnectorChange {
  name?: string;
  auth?: string;
  authGeneration?: string;
  policy?: string | null;
  secret?: string | null;
  detail?: string | null;
}

export interface ConnectorEdit {
  change: ConnectorChange;
}

export interface AssignInput {
  owner: string;
  connector: string;
  agent: string;
  policy: string | null | ((current: string | null) => string | null);
  actor: string;
  at: string;
}

export interface OrgConnectorStore {
  list: (owner: string) => Promise<{ connectors: ConnectorRow[]; assignments: AssignmentRow[] }>;
  find: (owner: string, id: string) => Promise<ConnectorRow | null>;
  count: (owner: string) => Promise<number>;
  create: (row: ConnectorRow) => Promise<void>;
  edit: (owner: string, id: string, at: string, edit: (row: ConnectorRow) => ConnectorEdit | Promise<ConnectorEdit>) => Promise<ConnectorRow>;
  remove: (owner: string, id: string) => Promise<ConnectorRow>;
  assign: (input: AssignInput) => Promise<AssignmentRow>;
  unassign: (input: Pick<AssignInput, 'owner' | 'connector' | 'agent'>) => Promise<void>;
}

const missing = (): ApiError => new ApiError('no such connector', 404);
const identityConflict = (): ApiError => new ApiError('This connector identity already exists. Nothing was overwritten.', 409);
const owned = (owner: string, id: string): SQL | undefined => and(eq(connectors.id, id), eq(connectors.owner, owner));

async function lockConnector(tx: Database, owner: string, id: string): Promise<ConnectorRow> {
  const rows = await tx.select().from(connectors).where(owned(owner, id)).for('update');
  const row = rows[0];
  if (row === undefined) throw missing();
  return row;
}

export async function editConnectorIn(tx: Database, owner: string, id: string, at: string, edit: (row: ConnectorRow) => ConnectorEdit | Promise<ConnectorEdit>): Promise<ConnectorRow> {
  const row = await lockConnector(tx, owner, id);
  const { change } = await edit(row);
  if (Object.keys(change).length === 0) return row;
  const saved = await tx.update(connectors).set({ ...change, updatedAt: at }).where(owned(owner, id)).returning();
  return saved[0] ?? row;
}

async function assignIn(tx: Database, input: AssignInput): Promise<AssignmentRow> {
  const connector = await lockConnector(tx, input.owner, input.connector);
  const agent = await tx.select({ id: agents.id }).from(agents).where(and(eq(agents.id, input.agent), eq(agents.owner, input.owner))).for('update');
  if (agent.length === 0) throw new ApiError('no such agent in this organization', 404);
  const held = await tx.select().from(connectorAgents).where(and(eq(connectorAgents.connector, connector.id), eq(connectorAgents.agent, input.agent)));
  const before = held[0];
  const policy = typeof input.policy === 'function' ? input.policy(before?.policy ?? null) : input.policy;
  if (before !== undefined && before.policy === policy) return before;
  const row: AssignmentRow = { connector: connector.id, agent: input.agent, policy, createdBy: input.actor, createdAt: input.at };
  const saved = await tx.insert(connectorAgents).values(row).onConflictDoUpdate({ target: [connectorAgents.connector, connectorAgents.agent], set: { policy } }).returning();
  return saved[0] ?? row;
}

async function unassignIn(tx: Database, input: Pick<AssignInput, 'owner' | 'connector' | 'agent'>): Promise<void> {
  const connector = await lockConnector(tx, input.owner, input.connector);
  const gone = await tx.delete(connectorAgents).where(and(eq(connectorAgents.connector, connector.id), eq(connectorAgents.agent, input.agent))).returning({ agent: connectorAgents.agent });
  if (gone.length === 0) throw new ApiError('that agent does not have this connector', 404);
}

async function listFor(db: Database, owner: string): Promise<{ connectors: ConnectorRow[]; assignments: AssignmentRow[] }> {
  const rows = await db.select().from(connectors).where(eq(connectors.owner, owner)).orderBy(connectors.name);
  const assignments = await db
    .select({ connector: connectorAgents.connector, agent: connectorAgents.agent, policy: connectorAgents.policy, createdBy: connectorAgents.createdBy, createdAt: connectorAgents.createdAt })
    .from(connectorAgents)
    .innerJoin(connectors, and(eq(connectors.id, connectorAgents.connector), eq(connectors.owner, owner)))
    .innerJoin(agents, and(eq(agents.id, connectorAgents.agent), eq(agents.owner, owner)));
  return { connectors: rows, assignments };
}

async function unique<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (isUniqueViolation(err)) throw identityConflict();
    throw err;
  }
}

export function orgConnectorStore(db: () => Database): OrgConnectorStore {
  return {
    list: (owner) => listFor(db(), owner),
    find: async (owner, id) => (await db().select().from(connectors).where(owned(owner, id)).limit(1))[0] ?? null,
    count: (owner) => db().$count(connectors, eq(connectors.owner, owner)),
    create: async (row) => { await unique(() => db().insert(connectors).values(row)); },
    edit: (owner, id, at, edit) => unique(() => db().transaction((tx) => editConnectorIn(tx, owner, id, at, edit))),
    remove: (owner, id) =>
      db().transaction(async (tx) => {
        const row = await lockConnector(tx, owner, id);
        await tx.delete(connectors).where(owned(owner, id));
        return row;
      }),
    assign: (input) => db().transaction((tx) => assignIn(tx, input)),
    unassign: (input) => db().transaction((tx) => unassignIn(tx, input)),
  };
}
