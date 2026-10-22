import { and, eq } from 'drizzle-orm';
import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { MCP_APPROVAL_ID_RE } from '@metro-labs/http/mcp-server-protocol';
import type { Session } from '@metro-labs/http/workos-token';
import { connectorKeys } from '@metro-labs/connectors/connector-keys';
import { createAgentToken, listAgentTokens, revokeAgentToken, TOKEN_LABEL_MAX, type AgentTokenRow } from '@metro-labs/connectors/db/agent-tokens';
import type { Database } from '@metro-labs/connectors/db/database';
import { approvalStore, type ApprovalRow } from '@metro-labs/connectors/db/mcp-approvals';
import { agents, connectorAgents, connectors } from '../db/schema.js';

export interface RemoteDeps {
  db: () => Database;
  now: () => number;
}

interface TokenView {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

interface ApprovalView {
  id: string;
  connector: string;
  connectorKey: string;
  connectorName: string | null;
  connectorUrl: string | null;
  tool: string;
  preview: string;
  requestedAt: number;
}

const tokenView = (row: AgentTokenRow): TokenView => ({ id: row.id, label: row.label, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt, revokedAt: row.revokedAt });

const noAgent = (): ApiError => new ApiError('no such agent', 404);

async function agentKind(db: Database, owner: string, agent: string): Promise<string> {
  const rows = await db.select({ kind: agents.kind }).from(agents).where(and(eq(agents.id, agent), eq(agents.owner, owner))).limit(1);
  const row = rows[0];
  if (row === undefined) throw noAgent();
  return row.kind;
}

async function remoteAgent(db: Database, owner: string, agent: string): Promise<void> {
  if ((await agentKind(db, owner, agent)) !== 'remote') throw new ApiError('This agent has its own server. Answer its approvals on its page, where its server keeps them.', 409);
}

function labelOf(body: unknown): string {
  const raw = isRecord(body) && typeof body.label === 'string' ? body.label : '';
  const label = raw.replace(/[\p{Cc}]/gu, '').trim();
  if (label === '' || label.length > TOKEN_LABEL_MAX) throw new ApiError(`Give the key a name of 1 to ${String(TOKEN_LABEL_MAX)} characters.`, 400);
  return label;
}

export async function agentTokens(deps: RemoteDeps, owner: string, agent: string): Promise<{ tokens: TokenView[] }> {
  const db = deps.db();
  await agentKind(db, owner, agent);
  return { tokens: (await listAgentTokens(db, owner, agent)).map(tokenView) };
}

export async function newAgentToken(deps: RemoteDeps, session: Session, owner: string, agent: string, body: unknown): Promise<{ token: TokenView; key: string }> {
  const label = labelOf(body);
  const made = await createAgentToken(deps.db(), { owner, agent, label, createdBy: session.userId, now: deps.now() });
  log.info({ owner, agent, token: made.row.id, by: session.userId }, 'agents: an access key was created');
  return { token: tokenView(made.row), key: made.token };
}

export async function dropAgentToken(deps: RemoteDeps, session: Session, owner: string, agent: string, id: string): Promise<{ token: TokenView }> {
  const row = await revokeAgentToken(deps.db(), owner, agent, id, deps.now());
  log.info({ owner, agent, token: id, by: session.userId }, 'agents: an access key was revoked');
  return { token: tokenView(row) };
}

async function assignedKeys(db: Database, owner: string, agent: string): Promise<Map<string, { key: string; name: string; url: string }>> {
  const rows = await db
    .select({ id: connectors.id, name: connectors.name, url: connectors.url })
    .from(connectorAgents)
    .innerJoin(connectors, and(eq(connectors.id, connectorAgents.connector), eq(connectors.owner, owner)))
    .where(eq(connectorAgents.agent, agent));
  const keys = connectorKeys(rows);
  return new Map(rows.map((row) => [row.id, { key: keys.get(row.id) ?? row.id, name: row.name, url: row.url }]));
}

function approvalView(row: ApprovalRow, known: Map<string, { key: string; name: string; url: string }>): ApprovalView {
  const connector = known.get(row.connector);
  return { id: row.id, connector: row.connector, connectorKey: connector?.key ?? row.connector, connectorName: connector?.name ?? null, connectorUrl: connector?.url ?? null, tool: row.tool, preview: row.preview, requestedAt: row.requestedAt };
}

export async function agentApprovals(deps: RemoteDeps, owner: string, agent: string): Promise<{ approvals: ApprovalView[] }> {
  const db = deps.db();
  await remoteAgent(db, owner, agent);
  const rows = await approvalStore(() => db).pending({ agent, owner }, deps.now());
  if (rows.length === 0) return { approvals: [] };
  const known = await assignedKeys(db, owner, agent);
  return { approvals: rows.map((row) => approvalView(row, known)) };
}

function decisionOf(body: unknown): 'allow' | 'deny' {
  const decision = isRecord(body) ? body.decision : undefined;
  if (decision !== 'allow' && decision !== 'deny') throw new ApiError('decision must be allow or deny', 400);
  return decision;
}

export async function answerAgentApproval(deps: RemoteDeps, session: Session, owner: string, agent: string, id: string, body: unknown): Promise<{ ok: true }> {
  if (!MCP_APPROVAL_ID_RE.test(id)) throw new ApiError('No pending approval has that id.', 404);
  const decision = decisionOf(body);
  const db = deps.db();
  await remoteAgent(db, owner, agent);
  if (!(await approvalStore(() => db).answer({ agent, owner }, id, decision, deps.now()))) throw new ApiError('No pending approval has that id.', 404);
  log.info({ owner, agent, id, decision, by: session.userId }, 'agents: an approval was answered on metro.box');
  return { ok: true };
}
