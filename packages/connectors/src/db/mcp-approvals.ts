import { and, eq, gte, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { bigint, pgTable, text } from 'drizzle-orm/pg-core';
import { approvalId } from '@metro-labs/core/ids';
import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import type { McpDecision } from '@metro-labs/http/mcp-server-protocol';
import { agentTokenLabels } from './agent-tokens.js';
import type { Database } from './database.js';
import { isUndefinedColumn } from './errors.js';
import { mcpApprovals } from './schema.js';

export const APPROVAL_TTL_MS = 24 * 60 * 60_000;
export const GRANT_WINDOW_MS = 10 * 60_000;
export const REDELIVER_MS = 60_000;
export const PENDING_MAX = 50;
export const APPROVAL_KEEP_MS = 7 * 24 * 60 * 60_000;

const ID_TRIES = 8;

export type ApprovalRow = typeof mcpApprovals.$inferSelect;

export interface DeliveredApproval extends ApprovalRow {
  keyLabel: string | null;
}

export interface ApprovalAgent {
  agent: string;
  owner: string;
}

export interface ApprovalRequest {
  connector: string;
  tool: string;
  digest: string;
  preview: string;
  token?: string;
}

export type Redeemed = 'used' | 'denied' | 'invalid';

export interface ApprovalStore {
  request: (identity: ApprovalAgent, request: ApprovalRequest, now: number) => Promise<string>;
  redeem: (identity: ApprovalAgent, id: string, request: ApprovalRequest, now: number) => Promise<Redeemed>;
  deliver: (identity: ApprovalAgent, now: number) => Promise<DeliveredApproval[]>;
  answer: (identity: ApprovalAgent, id: string, decision: McpDecision, now: number) => Promise<boolean>;
  pending: (identity: ApprovalAgent, now: number) => Promise<ApprovalRow[]>;
}

const mine = (identity: ApprovalAgent) => and(eq(mcpApprovals.agent, identity.agent), eq(mcpApprovals.owner, identity.owner));

const sameCall = (identity: ApprovalAgent, request: ApprovalRequest) =>
  and(mine(identity), eq(mcpApprovals.connector, request.connector), eq(mcpApprovals.tool, request.tool), eq(mcpApprovals.argsDigest, request.digest));

const sameCaller = (request: ApprovalRequest) => (request.token === undefined ? isNull(mcpApprovals.token) : eq(mcpApprovals.token, request.token));

const beforeOrigin = pgTable('mcp_approvals', {
  id: text('id').primaryKey(),
  owner: text('owner').notNull(),
  agent: text('agent').notNull(),
  connector: text('connector').notNull(),
  tool: text('tool').notNull(),
  argsDigest: text('args_digest').notNull(),
  preview: text('preview').notNull(),
  state: text('state').notNull(),
  requestedAt: bigint('requested_at', { mode: 'number' }).notNull(),
  answeredAt: bigint('answered_at', { mode: 'number' }),
  deliveredAt: bigint('delivered_at', { mode: 'number' }),
});

type Tolerate = <T>(work: (hasOrigin: boolean) => Promise<T>) => Promise<T>;

function untilMigrated(): Tolerate {
  let waiting = false;
  return async (work) => {
    try {
      const done = await work(true);
      waiting = false;
      return done;
    } catch (err) {
      if (!isUndefinedColumn(err)) throw err;
      if (!waiting) log.warn('mcp approvals: mcp_approvals has no origin column yet, so approvals are kept without who made the call until api.metro.box migrates');
      waiting = true;
      return work(false);
    }
  };
}

async function expire(db: Database, identity: ApprovalAgent, now: number): Promise<void> {
  await db
    .update(mcpApprovals)
    .set({ state: 'expired', answeredAt: now })
    .where(and(mine(identity), eq(mcpApprovals.state, 'pending'), lt(mcpApprovals.requestedAt, now - APPROVAL_TTL_MS)));
}

async function pendingId(db: Database, identity: ApprovalAgent, request: ApprovalRequest, hasOrigin: boolean): Promise<string | null> {
  const rows = await db.select({ id: mcpApprovals.id }).from(mcpApprovals).where(and(sameCall(identity, request), eq(mcpApprovals.state, 'pending'), hasOrigin ? sameCaller(request) : undefined)).limit(1);
  return rows[0]?.id ?? null;
}

async function insertRow(db: Database, row: typeof beforeOrigin.$inferInsert, request: ApprovalRequest, hasOrigin: boolean): Promise<string | undefined> {
  if (!hasOrigin) return (await db.insert(beforeOrigin).values(row).onConflictDoNothing().returning({ id: beforeOrigin.id }))[0]?.id;
  const caller = request.token === undefined ? { origin: 'box', token: null } : { origin: 'key', token: request.token };
  return (await db.insert(mcpApprovals).values({ ...row, ...caller }).onConflictDoNothing().returning({ id: mcpApprovals.id }))[0]?.id;
}

async function insertPending(db: Database, identity: ApprovalAgent, request: ApprovalRequest, now: number, hasOrigin: boolean): Promise<string> {
  for (let attempt = 0; attempt < ID_TRIES; attempt += 1) {
    const row = { id: approvalId(), owner: identity.owner, agent: identity.agent, connector: request.connector, tool: request.tool, argsDigest: request.digest, preview: request.preview, state: 'pending', requestedAt: now, answeredAt: null, deliveredAt: null };
    const inserted = await insertRow(db, row, request, hasOrigin);
    if (inserted !== undefined) return inserted;
    const held = await pendingId(db, identity, request, hasOrigin);
    if (held !== null) return held;
  }
  throw new ApiError('Metro could not record the approval request. Try again.', 503);
}

async function request(db: Database, identity: ApprovalAgent, call: ApprovalRequest, now: number, hasOrigin: boolean): Promise<string> {
  await expire(db, identity, now);
  const held = await pendingId(db, identity, call, hasOrigin);
  if (held !== null) return held;
  const waiting = await db.$count(mcpApprovals, and(mine(identity), eq(mcpApprovals.state, 'pending')));
  if (waiting >= PENDING_MAX) throw new ApiError(`${String(PENDING_MAX)} approval requests are already waiting for the owner. Wait for answers before asking again.`, 429);
  return insertPending(db, identity, call, now, hasOrigin);
}

async function redeem(db: Database, identity: ApprovalAgent, id: string, call: ApprovalRequest, now: number): Promise<Redeemed> {
  const used = await db
    .update(mcpApprovals)
    .set({ state: 'used' })
    .where(and(eq(mcpApprovals.id, id), sameCall(identity, call), eq(mcpApprovals.state, 'allow'), gte(mcpApprovals.answeredAt, now - GRANT_WINDOW_MS)))
    .returning({ id: mcpApprovals.id });
  if (used.length > 0) return 'used';
  const denied = await db.select({ id: mcpApprovals.id }).from(mcpApprovals).where(and(eq(mcpApprovals.id, id), sameCall(identity, call), eq(mcpApprovals.state, 'deny'))).limit(1);
  return denied.length > 0 ? 'denied' : 'invalid';
}

async function markDelivered(db: Database, identity: ApprovalAgent, due: SQL | undefined, now: number, hasOrigin: boolean): Promise<DeliveredApproval[]> {
  if (!hasOrigin) return (await db.update(beforeOrigin).set({ deliveredAt: now }).where(due).returning()).map((row) => ({ ...row, origin: null, token: null, keyLabel: null }));
  const rows = await db.update(mcpApprovals).set({ deliveredAt: now }).where(due).returning();
  const labels = await agentTokenLabels(db, identity, rows.flatMap((row) => (row.token === null ? [] : [row.token])));
  return rows.map((row) => ({ ...row, keyLabel: row.token === null ? null : (labels.get(row.token) ?? null) }));
}

async function deliver(db: Database, identity: ApprovalAgent, now: number, hasOrigin: boolean): Promise<DeliveredApproval[]> {
  await expire(db, identity, now);
  const due = and(mine(identity), eq(mcpApprovals.state, 'pending'), or(isNull(mcpApprovals.deliveredAt), lt(mcpApprovals.deliveredAt, now - REDELIVER_MS)));
  return (await markDelivered(db, identity, due, now, hasOrigin)).sort((a, b) => a.requestedAt - b.requestedAt);
}

async function pending(db: Database, identity: ApprovalAgent, now: number): Promise<ApprovalRow[]> {
  const live = and(mine(identity), eq(mcpApprovals.state, 'pending'), gte(mcpApprovals.requestedAt, now - APPROVAL_TTL_MS));
  return db.select().from(mcpApprovals).where(live).orderBy(mcpApprovals.requestedAt, mcpApprovals.id).limit(PENDING_MAX);
}

async function answer(db: Database, identity: ApprovalAgent, id: string, decision: McpDecision, now: number): Promise<boolean> {
  await expire(db, identity, now);
  const rows = await db
    .update(mcpApprovals)
    .set({ state: decision, answeredAt: now })
    .where(and(eq(mcpApprovals.id, id), mine(identity), eq(mcpApprovals.state, 'pending')))
    .returning({ id: mcpApprovals.id });
  return rows.length > 0;
}

const SETTLED = ['allow', 'deny', 'used', 'expired'];

export async function pruneApprovals(db: Database, now: number): Promise<number> {
  const lastChange = sql<number>`coalesce(${mcpApprovals.answeredAt}, ${mcpApprovals.requestedAt})`;
  const removed = await db
    .delete(mcpApprovals)
    .where(or(
      and(inArray(mcpApprovals.state, SETTLED), lt(lastChange, now - APPROVAL_KEEP_MS)),
      and(eq(mcpApprovals.state, 'pending'), lt(mcpApprovals.requestedAt, now - APPROVAL_TTL_MS - APPROVAL_KEEP_MS)),
    ))
    .returning({ id: mcpApprovals.id });
  return removed.length;
}

export function approvalStore(db: () => Database): ApprovalStore {
  const tolerate = untilMigrated();
  return {
    request: (identity, call, now) => tolerate((hasOrigin) => request(db(), identity, call, now, hasOrigin)),
    redeem: (identity, id, call, now) => redeem(db(), identity, id, call, now),
    deliver: (identity, now) => tolerate((hasOrigin) => deliver(db(), identity, now, hasOrigin)),
    answer: (identity, id, decision, now) => answer(db(), identity, id, decision, now),
    pending: (identity, now) => pending(db(), identity, now),
  };
}
