import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import { newId } from '@metro-labs/core/ids';
import { ApiError } from '@metro-labs/http/api-error';
import { AGENT_TOKENS_MAX, tokenHashOf } from './agent-tokens.js';
import type { Database } from './database.js';
import { agents, agentTokens, oauthGrants } from './schema.js';

export const GRANT_REQUEST_MS = 15 * 60_000;
export const GRANT_CODE_MS = 5 * 60_000;
export const GRANTS_OPEN_MAX = 5000;

export type OauthGrantRow = typeof oauthGrants.$inferSelect;

export interface GrantRequest {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
}

export interface GrantApproval {
  id: string;
  owner: string;
  agent: string;
  by: string;
  now: number;
}

export interface ApprovedGrant {
  owner: string;
  agent: string;
  createdBy: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
}

const gone = (): ApiError => new ApiError('This sign-in request is no longer open. Start again from the app.', 404);

export function redirectWith(uri: string, params: Record<string, string | null>): string {
  const url = new URL(uri);
  for (const [name, value] of Object.entries(params)) if (value !== null) url.searchParams.set(name, value);
  return url.toString();
}

export async function openGrant(db: Database, request: GrantRequest, now: number): Promise<string> {
  await db.delete(oauthGrants).where(lt(oauthGrants.expiresAt, now));
  if ((await db.$count(oauthGrants, isNull(oauthGrants.codeHash))) >= GRANTS_OPEN_MAX) throw new ApiError('Too many sign-ins are waiting on Metro right now. Try again in a few minutes.', 503);
  const id = newId();
  await db.insert(oauthGrants).values({ id, ...request, createdAt: now, expiresAt: now + GRANT_REQUEST_MS });
  return id;
}

const pendingOf = (id: string, now: number) => and(eq(oauthGrants.id, id), isNull(oauthGrants.codeHash), gt(oauthGrants.expiresAt, now));

export async function pendingGrant(db: Database, id: string, now: number): Promise<OauthGrantRow | null> {
  const rows = await db.select().from(oauthGrants).where(pendingOf(id, now)).limit(1);
  return rows[0] ?? null;
}

async function checkAgent(tx: Database, owner: string, agent: string): Promise<void> {
  const rows = await tx.select({ id: agents.id }).from(agents).where(and(eq(agents.id, agent), eq(agents.owner, owner))).limit(1);
  if (rows[0] === undefined) throw new ApiError('no such agent', 404);
  const live = await tx.$count(agentTokens, and(eq(agentTokens.agent, agent), eq(agentTokens.owner, owner), isNull(agentTokens.revokedAt)));
  if (live >= AGENT_TOKENS_MAX) throw new ApiError(`This agent already has ${String(AGENT_TOKENS_MAX)} access keys. Revoke one on its page first.`, 409);
}

async function approveIn(tx: Database, approval: GrantApproval): Promise<string> {
  const rows = await tx.select().from(oauthGrants).where(pendingOf(approval.id, approval.now)).for('update');
  const row = rows[0];
  if (row === undefined) throw gone();
  await checkAgent(tx, approval.owner, approval.agent);
  const code = `mcc_${randomBytes(32).toString('base64url')}`;
  await tx
    .update(oauthGrants)
    .set({ owner: approval.owner, agent: approval.agent, createdBy: approval.by, codeHash: tokenHashOf(code), expiresAt: approval.now + GRANT_CODE_MS })
    .where(eq(oauthGrants.id, row.id));
  return redirectWith(row.redirectUri, { code, state: row.state });
}

export function approveGrant(db: Database, approval: GrantApproval): Promise<string> {
  return db.transaction((tx) => approveIn(tx, approval));
}

export async function denyGrant(db: Database, id: string, now: number): Promise<string> {
  const rows = await db.delete(oauthGrants).where(pendingOf(id, now)).returning();
  const row = rows[0];
  if (row === undefined) throw gone();
  return redirectWith(row.redirectUri, { error: 'access_denied', error_description: 'The person declined in Metro.', state: row.state });
}

export async function redeemGrant(db: Database, code: string, now: number): Promise<ApprovedGrant | null> {
  const rows = await db.delete(oauthGrants).where(eq(oauthGrants.codeHash, tokenHashOf(code))).returning();
  const row = rows[0];
  if (row === undefined || row.expiresAt <= now || row.owner === null || row.agent === null || row.createdBy === null) return null;
  return { owner: row.owner, agent: row.agent, createdBy: row.createdBy, clientId: row.clientId, clientName: row.clientName, redirectUri: row.redirectUri, codeChallenge: row.codeChallenge };
}
