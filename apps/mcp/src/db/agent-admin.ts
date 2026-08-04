import { randomBytes } from 'node:crypto';
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import { ApiError } from '../daemon/api-error.js';
import { getDb } from './client.js';
import { registerKey, unregisterAgentKey } from './key-map.js';
import { accounts, agents, users } from './schema.js';

export const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$/;

export class AgentAdminError extends ApiError {}

export interface AgentSummary {
  id: number;
  name: string;
  owned: boolean;
  key: string | null;
}

export interface CreatedAgent {
  id: number;
  name: string;
  key: string;
}

export interface OwnedAgent {
  id: number;
  name: string;
}

export type DeletedAgent = OwnedAgent;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function normalizeAgentName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!AGENT_NAME_RE.test(name))
    throw new AgentAdminError(
      'name must be 2-32 characters of A-Z, a-z, 0-9, - or _, starting with a letter or digit',
      400,
    );
  return name;
}

export function newApiKey(): string {
  return `mk_${randomBytes(32).toString('base64url')}`;
}

export function servesEveryAgent(): boolean {
  return (process.env.METRO_AGENT?.trim() ?? '') === '';
}

const grantedOperatorRows = (granted: string[]) =>
  and(isNull(agents.ownerId), inArray(agents.name, granted));

export async function userIdForEmail(rawEmail: string): Promise<number | null> {
  const rows = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalizeEmail(rawEmail)));
  return rows[0]?.id ?? null;
}

export async function resolveUserId(
  insert: () => Promise<number | undefined>,
  lookup: () => Promise<number | null>,
): Promise<number> {
  const inserted = await insert();
  if (inserted !== undefined) return inserted;
  const existing = await lookup();
  if (existing === null)
    throw new AgentAdminError('user lookup returned no id', 500);
  return existing;
}

export async function ensureUser(rawEmail: string): Promise<number> {
  const email = normalizeEmail(rawEmail);
  return resolveUserId(
    async () => {
      const rows = await getDb()
        .insert(users)
        .values({ email })
        .onConflictDoNothing({ target: users.email })
        .returning({ id: users.id });
      return rows[0]?.id;
    },
    () => userIdForEmail(email),
  );
}

export async function operatorAgentIdsByName(
  granted: string[],
): Promise<number[]> {
  if (granted.length === 0) return [];
  const rows = await getDb()
    .select({ id: agents.id })
    .from(agents)
    .where(grantedOperatorRows(granted))
    .orderBy(asc(agents.id));
  return rows.map((r) => r.id);
}

interface AgentRow {
  id: number;
  name: string;
  ownerId: number | null;
}

interface KeyRow {
  agentId: number;
  key: string | null;
}

function ownedIdsOf(ownerId: number | null, rows: AgentRow[]): number[] {
  if (ownerId === null) return [];
  return rows.filter((r) => r.ownerId === ownerId).map((r) => r.id);
}

export function toAgentSummaries(
  ownerId: number | null,
  rows: AgentRow[],
  keyRows: KeyRow[],
): AgentSummary[] {
  const owned = new Set(ownedIdsOf(ownerId, rows));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    owned: owned.has(r.id),
    key: owned.has(r.id)
      ? keyRows.find((k) => k.agentId === r.id)?.key ?? null
      : null,
  }));
}

async function selectKeyRows(ownedIds: number[]): Promise<KeyRow[]> {
  if (ownedIds.length === 0) return [];
  return getDb()
    .select({ agentId: agents.id, key: agents.key })
    .from(agents)
    .where(inArray(agents.id, ownedIds));
}

function visibleAgents(ownerId: number | null, granted: string[]) {
  const mine = ownerId === null ? undefined : eq(agents.ownerId, ownerId);
  if (granted.length === 0) return mine;
  const grants = grantedOperatorRows(granted);
  return mine === undefined ? grants : or(mine, grants);
}

export async function listAgentsForEmail(
  email: string,
  granted: string[],
): Promise<AgentSummary[]> {
  const ownerId = await userIdForEmail(email);
  const where = visibleAgents(ownerId, granted);
  if (where === undefined) return [];
  const rows = await getDb()
    .select({ id: agents.id, name: agents.name, ownerId: agents.ownerId })
    .from(agents)
    .where(where)
    .orderBy(asc(agents.id));
  if (rows.length === 0) return [];
  const keyRows = await selectKeyRows(ownedIdsOf(ownerId, rows));
  return toAgentSummaries(ownerId, rows, keyRows);
}

async function insertAgent(
  ownerId: number,
  name: string,
  key: string,
): Promise<number> {
  const inserted = await getDb()
    .insert(agents)
    .values({ name, ownerId, key })
    .returning({ id: agents.id });
  const id = inserted[0]?.id;
  if (id === undefined)
    throw new AgentAdminError('agent insert returned no id', 500);
  return id;
}

export async function createAgentForEmail(
  email: string,
  rawName: string,
): Promise<CreatedAgent> {
  const name = normalizeAgentName(rawName);
  const key = newApiKey();
  const id = await insertAgent(await ensureUser(email), name, key);
  if (servesEveryAgent()) registerKey(key, id);
  return { id, name, key };
}

export function parseAgentId(raw: string): number | null {
  if (!/^[1-9][0-9]{0,9}$/.test(raw)) return null;
  return Number(raw);
}

interface Deletable {
  agent: DeletedAgent;
  ownerId: number;
}

export async function ownedAgentOrThrow(
  ownerId: number | null,
  granted: string[],
  id: number,
  verb: string,
): Promise<Deletable> {
  const rows = await getDb().select().from(agents).where(eq(agents.id, id));
  const row = rows[0];
  const missing = new AgentAdminError('no such agent', 404);
  if (!row) throw missing;
  if (row.ownerId === null) {
    if (!granted.includes(row.name)) throw missing;
    throw new AgentAdminError(
      `operator-provisioned agents cannot be ${verb} here`,
      403,
    );
  }
  if (ownerId === null || row.ownerId !== ownerId) throw missing;
  return { agent: { id: row.id, name: row.name }, ownerId };
}

export async function deleteAgentForEmail(
  email: string,
  granted: string[],
  id: number,
): Promise<DeletedAgent> {
  const { agent, ownerId } = await ownedAgentOrThrow(
    await userIdForEmail(email),
    granted,
    id,
    'deleted',
  );
  await getDb().transaction(async (tx) => {
    const attached = await tx
      .select({ accountId: accounts.accountId })
      .from(accounts)
      .where(eq(accounts.agentId, id));
    if (attached.length > 0)
      throw new AgentAdminError(
        `agent '${agent.name}' still has ${attached.length} station account(s) attached — an operator must remove them first`,
        409,
      );
    const gone = await tx
      .delete(agents)
      .where(and(eq(agents.id, id), eq(agents.ownerId, ownerId)))
      .returning({ id: agents.id });
    if (gone.length === 0) throw new AgentAdminError('no such agent', 404);
  });
  unregisterAgentKey(id);
  return agent;
}
