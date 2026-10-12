import { and, eq, type SQL } from 'drizzle-orm';
import { newId } from '@metro-labs/core/ids';
import { ApiError } from '@metro-labs/http/api-error';
import type { MigrationRequest } from '@metro-labs/http/connector-migration';
import { notEnrolled } from '../agents/auth.js';
import { agentKeyStore, type AgentKeyRow } from './agent-keys.js';
import type { Database } from './client.js';
import { eventRow } from './connector-events.js';
import type { AssignmentRow, ConnectorRow } from './connectors.js';
import { isUniqueViolation } from './errors.js';
import { agents, connectorAgents, connectorEvents, connectorMigrations, connectors } from './schema.js';

export type MigrationRow = typeof connectorMigrations.$inferSelect;

export interface MigrationState {
  mapping: MigrationRow;
  connector: ConnectorRow | null;
  assignments: AssignmentRow[];
}

export interface MigrationChange {
  mapping?: Partial<Pick<MigrationRow, 'phase' | 'snapshot' | 'configStamp' | 'updatedAt'>>;
  create?: ConnectorRow;
  assignment?: 'create' | 'remove';
}

export interface ConnectorMigrationStore {
  begin: (identity: AgentKeyRow, create: (id: string) => MigrationRow, replace?: boolean) => Promise<MigrationState>;
  change: (identity: AgentKeyRow, input: Pick<MigrationRequest, 'operationId' | 'sourceId'>, edit: (state: MigrationState) => MigrationChange) => Promise<MigrationState>;
}

export const migrationConflict = (): ApiError => new ApiError('This connector migration changed. Start again from its current status.', 409);
const sourceFilter = (identity: AgentKeyRow, sourceId: string): SQL | undefined => and(eq(connectorMigrations.owner, identity.owner), eq(connectorMigrations.agent, identity.agent), eq(connectorMigrations.sourceId, sourceId));

function checkBinding(row: MigrationRow, identity: AgentKeyRow): void {
  if (row.keyId !== identity.keyId || row.enrolledAt !== identity.enrolledAt || row.signingKey !== identity.signingKey || row.sealingKey !== identity.sealingKey) throw migrationConflict();
}

async function lockIdentity(tx: Database, identity: AgentKeyRow): Promise<void> {
  const rows = await tx.select({ id: agents.id }).from(agents).where(and(eq(agents.id, identity.agent), eq(agents.owner, identity.owner))).for('update');
  if (rows.length !== 1) throw notEnrolled();
  const current = await agentKeyStore(() => tx).find(identity.keyId);
  if (current === null || current.agent !== identity.agent || current.owner !== identity.owner || current.enrolledAt !== identity.enrolledAt || current.signingKey !== identity.signingKey || current.sealingKey !== identity.sealingKey) throw notEnrolled();
}

async function stateIn(tx: Database, identity: AgentKeyRow, mapping: MigrationRow): Promise<MigrationState> {
  checkBinding(mapping, identity);
  const connector = (await tx.select().from(connectors).where(and(eq(connectors.id, mapping.destinationId), eq(connectors.owner, identity.owner))).for('update'))[0] ?? null;
  await lockIdentity(tx, identity);
  const assignments = await tx.select().from(connectorAgents).where(eq(connectorAgents.connector, mapping.destinationId)).for('update');
  return { mapping, connector, assignments };
}

function retiredOf(row: MigrationRow): string[] {
  const value: unknown = JSON.parse(row.retiredOperations);
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) throw migrationConflict();
  return value;
}

async function beginIn(tx: Database, identity: AgentKeyRow, create: (id: string) => MigrationRow, replace: boolean): Promise<MigrationState> {
  const candidate = create(newId());
  await tx.insert(connectorMigrations).values(candidate).onConflictDoNothing();
  const held = (await tx.select().from(connectorMigrations).where(sourceFilter(identity, candidate.sourceId)).for('update'))[0];
  if (held === undefined) throw migrationConflict();
  if (held.operationId === candidate.operationId) return stateIn(tx, identity, held);
  checkBinding(held, identity);
  const retired = retiredOf(held);
  if (!replace || held.phase !== 'rolled_back' || retired.includes(candidate.operationId) || retired.length >= 1000) throw migrationConflict();
  await lockIdentity(tx, identity);
  const next = { ...create(held.id), retiredOperations: JSON.stringify([...retired, held.operationId]) };
  const saved = (await tx.update(connectorMigrations).set(next).where(eq(connectorMigrations.id, held.id)).returning())[0];
  if (saved === undefined) throw migrationConflict();
  return { mapping: saved, connector: null, assignments: [] };
}

async function createAssignment(tx: Database, state: MigrationState, at: string): Promise<void> {
  const { mapping } = state;
  if (state.assignments.length !== 0) throw migrationConflict();
  const assignment: AssignmentRow = { connector: mapping.destinationId, agent: mapping.agent, policy: null, migrationOperation: mapping.operationId, createdBy: `agent:${mapping.agent}`, createdAt: at };
  await tx.insert(connectorAgents).values(assignment);
  state.assignments.push(assignment);
}

async function removeAssignment(tx: Database, state: MigrationState): Promise<void> {
  const { mapping } = state;
  await tx.delete(connectorAgents).where(and(eq(connectorAgents.connector, mapping.destinationId), eq(connectorAgents.agent, mapping.agent), eq(connectorAgents.migrationOperation, mapping.operationId)));
  state.assignments = state.assignments.filter((row) => row.agent !== mapping.agent || row.migrationOperation !== mapping.operationId);
}

async function createDestination(tx: Database, state: MigrationState, connector: ConnectorRow): Promise<void> {
  if (state.connector !== null || connector.id !== state.mapping.destinationId || await tx.$count(connectors, eq(connectors.owner, state.mapping.owner)) >= 100) throw migrationConflict();
  await tx.insert(connectors).values(connector);
  state.connector = connector;
}

async function applyIn(tx: Database, state: MigrationState, edit: MigrationChange): Promise<MigrationState> {
  const { mapping } = state;
  const at = edit.mapping?.updatedAt ?? mapping.updatedAt;
  if (edit.create !== undefined) await createDestination(tx, state, edit.create);
  if (edit.assignment === 'create') await createAssignment(tx, state, at);
  if (edit.assignment === 'remove') await removeAssignment(tx, state);
  if (edit.mapping !== undefined) {
    const saved = (await tx.update(connectorMigrations).set(edit.mapping).where(eq(connectorMigrations.id, mapping.id)).returning())[0];
    if (saved === undefined) throw migrationConflict();
    state.mapping = saved;
    if (saved.phase !== mapping.phase) await tx.insert(connectorEvents).values(eventRow({ owner: mapping.owner, connector: mapping.destinationId, agent: mapping.agent, actor: `agent:${mapping.agent}`, action: `connector.migration_${saved.phase}`, detail: {} }, at));
  }
  return state;
}

async function changeIn(tx: Database, identity: AgentKeyRow, input: Pick<MigrationRequest, 'operationId' | 'sourceId'>, edit: (state: MigrationState) => MigrationChange): Promise<MigrationState> {
  const mapping = (await tx.select().from(connectorMigrations).where(sourceFilter(identity, input.sourceId)).for('update'))[0];
  if (mapping === undefined || mapping.operationId !== input.operationId) throw migrationConflict();
  const state = await stateIn(tx, identity, mapping);
  return applyIn(tx, state, edit(state));
}

async function unique<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (isUniqueViolation(err)) throw new ApiError('A connector with that name or migration already exists. Nothing was merged.', 409);
    throw err;
  }
}

export function connectorMigrationStore(db: () => Database): ConnectorMigrationStore {
  return {
    begin: (identity, create, replace = true) => unique(() => db().transaction((tx) => beginIn(tx, identity, create, replace))),
    change: (identity, input, edit) => unique(() => db().transaction((tx) => changeIn(tx, identity, input, edit))),
  };
}
