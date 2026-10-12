import { and, desc, eq, lt, or, sql, type SQL } from 'drizzle-orm';
import { ApiError } from '@metro-labs/http/api-error';
import type { Database } from './client.js';
import { eventRow, type ConnectorEvent } from './connector-events.js';
import { isUniqueViolation } from './errors.js';
import { agents, connectorAgents, connectorEvents, connectorMigrations, connectors, users } from './schema.js';

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
  event: ConnectorEvent | null;
}

export interface AssignInput {
  owner: string;
  connector: string;
  agent: string;
  policy: string | null;
  actor: string;
  at: string;
}

export interface EventView {
  id: string;
  connector: string | null;
  agent: string | null;
  actor: string;
  action: string;
  detail: string | null;
  at: string;
  actorName: string | null;
  actorEmail: string | null;
  connectorName: string | null;
  agentName: string | null;
}

export interface EventPage {
  connector?: string;
  before?: { at: string; id: string };
  limit: number;
}

export interface OrgConnectorStore {
  list: (owner: string) => Promise<{ connectors: ConnectorRow[]; assignments: AssignmentRow[] }>;
  find: (owner: string, id: string) => Promise<ConnectorRow | null>;
  count: (owner: string) => Promise<number>;
  create: (row: ConnectorRow, event: ConnectorEvent) => Promise<void>;
  edit: (owner: string, id: string, at: string, edit: (row: ConnectorRow) => ConnectorEdit | Promise<ConnectorEdit>) => Promise<ConnectorRow>;
  remove: (owner: string, id: string, at: string, event: (row: ConnectorRow) => ConnectorEvent) => Promise<ConnectorRow>;
  assign: (input: AssignInput) => Promise<AssignmentRow>;
  unassign: (input: Omit<AssignInput, 'policy'>) => Promise<void>;
  events: (owner: string, page: EventPage) => Promise<EventView[]>;
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
  const { change, event } = await edit(row);
  if (Object.keys(change).length === 0 && event === null) return row;
  if (Object.keys(change).some((key) => ['name', 'auth', 'policy'].includes(key)) || (change.secret !== undefined && row.auth !== 'oauth')) await refusePreparing(tx, id);
  const saved = await tx.update(connectors).set({ ...change, updatedAt: at }).where(owned(owner, id)).returning();
  if (event !== null) await tx.insert(connectorEvents).values(eventRow(event, at));
  return saved[0] ?? row;
}

async function refusePreparing(tx: Database, id: string): Promise<void> {
  const held = (await tx.select({ phase: connectorMigrations.phase }).from(connectorMigrations).where(eq(connectorMigrations.destinationId, id)))[0];
  if (held?.phase === 'preparing' || held?.phase === 'prepared') throw new ApiError('Finish or roll back this connector migration before changing, assigning, or deleting its destination.', 409);
}

const policyChanged = (before: string | null, after: string | null): boolean => (before ?? '') !== (after ?? '');

async function assignIn(tx: Database, input: AssignInput): Promise<AssignmentRow> {
  const connector = await lockConnector(tx, input.owner, input.connector);
  await refusePreparing(tx, connector.id);
  const agent = await tx.select({ id: agents.id }).from(agents).where(and(eq(agents.id, input.agent), eq(agents.owner, input.owner))).for('update');
  if (agent.length === 0) throw new ApiError('no such agent in this organization', 404);
  const held = await tx.select().from(connectorAgents).where(and(eq(connectorAgents.connector, connector.id), eq(connectorAgents.agent, input.agent)));
  const before = held[0];
  if (before !== undefined && !policyChanged(before.policy, input.policy) && before.migrationOperation === null) return before;
  const row: AssignmentRow = { connector: connector.id, agent: input.agent, policy: input.policy, migrationOperation: null, createdBy: input.actor, createdAt: input.at };
  const saved = await tx.insert(connectorAgents).values(row).onConflictDoUpdate({ target: [connectorAgents.connector, connectorAgents.agent], set: { policy: input.policy, migrationOperation: null } }).returning();
  const action = before === undefined ? 'connector.assigned' : 'connector.assignment_changed';
  const detail = { name: connector.name, readOnly: input.policy === null ? 'no' : 'yes' };
  await tx.insert(connectorEvents).values(eventRow({ owner: input.owner, connector: connector.id, agent: input.agent, actor: input.actor, action, detail }, input.at));
  return saved[0] ?? row;
}

async function unassignIn(tx: Database, input: Omit<AssignInput, 'policy'>): Promise<void> {
  const connector = await lockConnector(tx, input.owner, input.connector);
  const gone = await tx.delete(connectorAgents).where(and(eq(connectorAgents.connector, connector.id), eq(connectorAgents.agent, input.agent))).returning({ agent: connectorAgents.agent });
  if (gone.length === 0) throw new ApiError('that agent does not have this connector', 404);
  await tx.insert(connectorEvents).values(eventRow({ owner: input.owner, connector: connector.id, agent: input.agent, actor: input.actor, action: 'connector.unassigned', detail: { name: connector.name } }, input.at));
}

const eventColumns = {
  id: connectorEvents.id,
  connector: connectorEvents.connector,
  agent: connectorEvents.agent,
  actor: connectorEvents.actor,
  action: connectorEvents.action,
  detail: connectorEvents.detail,
  at: connectorEvents.at,
  actorName: users.name,
  actorEmail: users.email,
  connectorName: connectors.name,
  agentName: agents.name,
};

function eventFilter(owner: string, page: EventPage): SQL | undefined {
  const parts: (SQL | undefined)[] = [eq(connectorEvents.owner, owner)];
  if (page.connector !== undefined) parts.push(eq(connectorEvents.connector, page.connector));
  const before = page.before;
  if (before !== undefined) parts.push(or(lt(connectorEvents.at, before.at), and(eq(connectorEvents.at, before.at), lt(connectorEvents.id, before.id))));
  return and(...parts);
}

async function listEvents(db: Database, owner: string, page: EventPage): Promise<EventView[]> {
  return db
    .select(eventColumns)
    .from(connectorEvents)
    .leftJoin(users, eq(sql`'user:' || ${users.id}`, connectorEvents.actor))
    .leftJoin(connectors, and(eq(connectors.id, connectorEvents.connector), eq(connectors.owner, connectorEvents.owner)))
    .leftJoin(agents, and(eq(agents.id, connectorEvents.agent), eq(agents.owner, connectorEvents.owner)))
    .where(eventFilter(owner, page))
    .orderBy(desc(connectorEvents.at), desc(connectorEvents.id))
    .limit(page.limit);
}

async function listFor(db: Database, owner: string): Promise<{ connectors: ConnectorRow[]; assignments: AssignmentRow[] }> {
  const rows = await db.select().from(connectors).where(eq(connectors.owner, owner)).orderBy(connectors.name);
  const assignments = await db
    .select({ connector: connectorAgents.connector, agent: connectorAgents.agent, policy: connectorAgents.policy, migrationOperation: connectorAgents.migrationOperation, createdBy: connectorAgents.createdBy, createdAt: connectorAgents.createdAt })
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
    create: (row, event) =>
      unique(() =>
        db().transaction(async (tx) => {
          await tx.insert(connectors).values(row);
          await tx.insert(connectorEvents).values(eventRow(event, row.createdAt));
        }),
      ),
    edit: (owner, id, at, edit) => unique(() => db().transaction((tx) => editConnectorIn(tx, owner, id, at, edit))),
    remove: (owner, id, at, event) =>
      db().transaction(async (tx) => {
        const row = await lockConnector(tx, owner, id);
        await refusePreparing(tx, id);
        await tx.delete(connectors).where(owned(owner, id));
        await tx.insert(connectorEvents).values(eventRow(event(row), at));
        return row;
      }),
    assign: (input) => db().transaction((tx) => assignIn(tx, input)),
    unassign: (input) => db().transaction((tx) => unassignIn(tx, input)),
    events: (owner, page) => listEvents(db(), owner, page),
  };
}
