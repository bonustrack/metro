import { randomBytes } from 'node:crypto';
import { asc, eq, inArray, or } from 'drizzle-orm';
import { getDb } from './client.js';
import { registerKey } from './key-map.js';
import { agents, keys } from './schema.js';

export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
export const DEFAULT_KEY_NAME = 'default';
export const DEFAULT_MAX_AGENTS_PER_OWNER = 5;

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

export function maxAgentsPerOwner(): number {
  const raw = Number(process.env.METRO_MAX_AGENTS_PER_OWNER);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_AGENTS_PER_OWNER;
}

export function servesEveryAgent(): boolean {
  return (process.env.METRO_AGENT?.trim() ?? '') === '';
}

const isUniqueViolation = (e: unknown): boolean =>
  typeof e === 'object' &&
  e !== null &&
  (e as { code?: unknown }).code === '23505';

export async function listAgentsForEmail(
  email: string,
  granted: string[],
): Promise<AgentSummary[]> {
  const owner = normalizeEmail(email);
  const db = getDb();
  const where =
    granted.length > 0
      ? or(eq(agents.ownerEmail, owner), inArray(agents.name, granted))
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
      throw new AgentAdminError(`agent name '${name}' is already taken`, 409);
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
  const limit = maxAgentsPerOwner();
  const owned = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.ownerEmail, owner));
  if (owned.length >= limit)
    throw new AgentAdminError(
      `agent limit reached — ${owner} already owns ${owned.length} of ${limit} agents`,
      403,
    );
  const clash = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.name, name));
  if (clash.length > 0)
    throw new AgentAdminError(`agent name '${name}' is already taken`, 409);
  const id = await insertAgent(owner, name);
  const key = newApiKey();
  await db.insert(keys).values({ agentId: id, name: DEFAULT_KEY_NAME, key });
  if (servesEveryAgent()) registerKey(key, name);
  return { id, name, key };
}
