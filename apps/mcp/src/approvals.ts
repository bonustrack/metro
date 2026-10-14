import { and, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { approvalId } from '@metro-labs/core/ids';
import { ApiError } from '@metro-labs/http/api-error';
import type { McpDecision } from '@metro-labs/http/mcp-server-protocol';
import type { AgentKeyRow } from '@metro-labs/connectors/db/agent-keys';
import type { Database } from '@metro-labs/connectors/db/database';
import { mcpApprovals } from '@metro-labs/connectors/db/schema';

export const APPROVAL_TTL_MS = 24 * 60 * 60_000;
export const GRANT_WINDOW_MS = 10 * 60_000;
export const REDELIVER_MS = 60_000;
export const PENDING_MAX = 50;
export const APPROVAL_KEEP_MS = 7 * 24 * 60 * 60_000;

const ID_TRIES = 8;

export type ApprovalRow = typeof mcpApprovals.$inferSelect;

export interface ApprovalRequest {
  connector: string;
  tool: string;
  digest: string;
  preview: string;
}

export type Redeemed = 'used' | 'denied' | 'invalid';

export interface ApprovalStore {
  request: (identity: AgentKeyRow, request: ApprovalRequest, now: number) => Promise<string>;
  redeem: (identity: AgentKeyRow, id: string, request: ApprovalRequest, now: number) => Promise<Redeemed>;
  deliver: (identity: AgentKeyRow, now: number) => Promise<ApprovalRow[]>;
  answer: (identity: AgentKeyRow, id: string, decision: McpDecision, now: number) => Promise<boolean>;
}

const mine = (identity: AgentKeyRow) => and(eq(mcpApprovals.agent, identity.agent), eq(mcpApprovals.owner, identity.owner));

const sameCall = (identity: AgentKeyRow, request: ApprovalRequest) =>
  and(mine(identity), eq(mcpApprovals.connector, request.connector), eq(mcpApprovals.tool, request.tool), eq(mcpApprovals.argsDigest, request.digest));

async function expire(db: Database, identity: AgentKeyRow, now: number): Promise<void> {
  await db
    .update(mcpApprovals)
    .set({ state: 'expired', answeredAt: now })
    .where(and(mine(identity), eq(mcpApprovals.state, 'pending'), lt(mcpApprovals.requestedAt, now - APPROVAL_TTL_MS)));
}

async function pendingId(db: Database, identity: AgentKeyRow, request: ApprovalRequest): Promise<string | null> {
  const rows = await db.select({ id: mcpApprovals.id }).from(mcpApprovals).where(and(sameCall(identity, request), eq(mcpApprovals.state, 'pending'))).limit(1);
  return rows[0]?.id ?? null;
}

async function insertPending(db: Database, identity: AgentKeyRow, request: ApprovalRequest, now: number): Promise<string> {
  for (let attempt = 0; attempt < ID_TRIES; attempt += 1) {
    const row: ApprovalRow = { id: approvalId(), owner: identity.owner, agent: identity.agent, connector: request.connector, tool: request.tool, argsDigest: request.digest, preview: request.preview, state: 'pending', requestedAt: now, answeredAt: null, deliveredAt: null };
    const inserted = await db.insert(mcpApprovals).values(row).onConflictDoNothing().returning({ id: mcpApprovals.id });
    if (inserted[0] !== undefined) return inserted[0].id;
    const held = await pendingId(db, identity, request);
    if (held !== null) return held;
  }
  throw new ApiError('Metro could not record the approval request. Try again.', 503);
}

async function request(db: Database, identity: AgentKeyRow, call: ApprovalRequest, now: number): Promise<string> {
  await expire(db, identity, now);
  const held = await pendingId(db, identity, call);
  if (held !== null) return held;
  const waiting = await db.$count(mcpApprovals, and(mine(identity), eq(mcpApprovals.state, 'pending')));
  if (waiting >= PENDING_MAX) throw new ApiError(`${String(PENDING_MAX)} approval requests are already waiting for the owner. Wait for answers before asking again.`, 429);
  return insertPending(db, identity, call, now);
}

async function redeem(db: Database, identity: AgentKeyRow, id: string, call: ApprovalRequest, now: number): Promise<Redeemed> {
  const used = await db
    .update(mcpApprovals)
    .set({ state: 'used' })
    .where(and(eq(mcpApprovals.id, id), sameCall(identity, call), eq(mcpApprovals.state, 'allow'), gte(mcpApprovals.answeredAt, now - GRANT_WINDOW_MS)))
    .returning({ id: mcpApprovals.id });
  if (used.length > 0) return 'used';
  const denied = await db.select({ id: mcpApprovals.id }).from(mcpApprovals).where(and(eq(mcpApprovals.id, id), sameCall(identity, call), eq(mcpApprovals.state, 'deny'))).limit(1);
  return denied.length > 0 ? 'denied' : 'invalid';
}

async function deliver(db: Database, identity: AgentKeyRow, now: number): Promise<ApprovalRow[]> {
  await expire(db, identity, now);
  const due = or(isNull(mcpApprovals.deliveredAt), lt(mcpApprovals.deliveredAt, now - REDELIVER_MS));
  const rows = await db.update(mcpApprovals).set({ deliveredAt: now }).where(and(mine(identity), eq(mcpApprovals.state, 'pending'), due)).returning();
  return rows.sort((a, b) => a.requestedAt - b.requestedAt);
}

async function answer(db: Database, identity: AgentKeyRow, id: string, decision: McpDecision, now: number): Promise<boolean> {
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
  return {
    request: (identity, call, now) => request(db(), identity, call, now),
    redeem: (identity, id, call, now) => redeem(db(), identity, id, call, now),
    deliver: (identity, now) => deliver(db(), identity, now),
    answer: (identity, id, decision, now) => answer(db(), identity, id, decision, now),
  };
}
