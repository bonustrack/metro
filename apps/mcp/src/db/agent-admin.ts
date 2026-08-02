import { randomBytes } from 'node:crypto';
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import { getDb } from './client.js';
import { registerKey, unregisterAgentKeys } from './key-map.js';
import { accounts, agents, keys } from './schema.js';

export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
export const DEFAULT_KEY_NAME = 'default';

export class AgentAdminError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface AgentSummary {
  id: number;
  name: string;
  owned: boolean;
  keys: string[];
}

export interface CreatedAgent {
  id: number;
  name: string;
  key: string;
}

export interface DeletedAgent {
  id: number;
  name: string;
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function normalizeAgentName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!AGENT_NAME_RE.test(name))
    throw new AgentAdminError(
      'name must be 2-32 characters of a-z, 0-9, - or _, starting with a letter or digit',
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

const isUniqueViolation = (e: unknown): boolean =>
  typeof e === 'object' &&
  e !== null &&
  (e as { code?: unknown }).code === '23505';

const grantedOperatorRows = (granted: string[]) =>
  and(isNull(agents.ownerEmail), inArray(agents.name, granted));

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

export async function listAgentsForEmail(
  email: string,
  granted: string[],
): Promise<AgentSummary[]> {
  const owner = normalizeEmail(email);
  const db = getDb();
  const where =
    granted.length > 0
      ? or(eq(agents.ownerEmail, owner), grantedOperatorRows(granted))
      : eq(agents.ownerEmail, owner);
  const rows = await db.select().from(agents).where(where).orderBy(asc(agents.id));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const keyRows = await db
    .select({ agentId: keys.agentId, name: keys.name })
    .from(keys)
    .where(inArray(keys.agentId, ids));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    owned: r.ownerEmail === owner,
    keys: keyRows.filter((k) => k.agentId === r.id).map((k) => k.name).sort(),
  }));
}

async function insertAgent(email: string, name: string): Promise<number> {
  const db = getDb();
  let inserted: { id: number }[];
  try {
    inserted = await db
      .insert(agents)
      .values({ name, ownerEmail: email })
      .returning({ id: agents.id });
  } catch (e) {
    if (isUniqueViolation(e))
      throw new AgentAdminError(`you already have an agent named '${name}'`, 409);
    throw e;
  }
  const id = inserted[0]?.id;
  if (id === undefined)
    throw new AgentAdminError('agent insert returned no id', 500);
  return id;
}

export async function createAgentForEmail(
  email: string,
  rawName: string,
): Promise<CreatedAgent> {
  const owner = normalizeEmail(email);
  const name = normalizeAgentName(rawName);
  const db = getDb();
  const clash = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.ownerEmail, owner), eq(agents.name, name)));
  if (clash.length > 0)
    throw new AgentAdminError(`you already have an agent named '${name}'`, 409);
  const id = await insertAgent(owner, name);
  const key = newApiKey();
  await db.insert(keys).values({ agentId: id, name: DEFAULT_KEY_NAME, key });
  if (servesEveryAgent()) registerKey(key, id);
  return { id, name, key };
}

export function parseAgentId(raw: string): number | null {
  if (!/^[1-9][0-9]{0,9}$/.test(raw)) return null;
  return Number(raw);
}

async function deletableAgent(
  owner: string,
  granted: string[],
  id: number,
): Promise<DeletedAgent> {
  const rows = await getDb().select().from(agents).where(eq(agents.id, id));
  const row = rows[0];
  const missing = new AgentAdminError('no such agent', 404);
  if (!row) throw missing;
  if (row.ownerEmail === null) {
    if (!granted.includes(row.name)) throw missing;
    throw new AgentAdminError(
      'operator-provisioned agents cannot be deleted here',
      403,
    );
  }
  if (row.ownerEmail !== owner) throw missing;
  return { id: row.id, name: row.name };
}

function revokeEnvToken(revoked: string[]): void {
  const current = process.env.METRO_MCP_HTTP_TOKEN;
  if (current !== undefined && revoked.includes(current))
    delete process.env.METRO_MCP_HTTP_TOKEN;
}

export async function deleteAgentForEmail(
  email: string,
  granted: string[],
  id: number,
): Promise<DeletedAgent> {
  const owner = normalizeEmail(email);
  const agent = await deletableAgent(owner, granted, id);
  const revoked = await getDb().transaction(async (tx) => {
    const attached = await tx
      .select({ accountId: accounts.accountId })
      .from(accounts)
      .where(eq(accounts.agentId, id));
    if (attached.length > 0)
      throw new AgentAdminError(
        `agent '${agent.name}' still has ${attached.length} station account(s) attached — an operator must remove them first`,
        409,
      );
    const held = await tx
      .select({ key: keys.key })
      .from(keys)
      .where(eq(keys.agentId, id));
    await tx.delete(keys).where(eq(keys.agentId, id));
    const gone = await tx
      .delete(agents)
      .where(and(eq(agents.id, id), eq(agents.ownerEmail, owner)))
      .returning({ id: agents.id });
    if (gone.length === 0) throw new AgentAdminError('no such agent', 404);
    return held.map((k) => k.key);
  });
  unregisterAgentKeys(id);
  revokeEnvToken(revoked);
  return agent;
}
