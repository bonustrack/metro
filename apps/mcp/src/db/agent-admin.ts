import { randomBytes } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { ApiError } from '../daemon/api-error.js';
import { getDb } from './client.js';
import { registerKey, rotateAgentKey, unregisterAgentKey } from './key-map.js';
import { newId, parseId } from './ids.js';
import { agents, stations } from './schema.js';
import { isUniqueViolation } from './users.js';
import { projectIdOrThrow } from './projects.js';

export const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$/;
const KEY_ATTEMPTS = 5;

export class AgentAdminError extends ApiError {}

export interface AgentSummary {
  id: string;
  name: string;
  owned: boolean;
  key: string | null;
}

export interface CreatedAgent {
  id: string;
  name: string;
  key: string;
}

export interface OwnedAgent {
  id: string;
  name: string;
}

export type DeletedAgent = OwnedAgent;

export interface ResetAgentKey extends OwnedAgent {
  key: string;
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

const agentPin = (): string => process.env.METRO_AGENT?.trim() ?? '';

export function servesEveryAgent(): boolean {
  return agentPin() === '';
}

export function daemonServesAgent(id: string): boolean {
  const pin = agentPin();
  return pin === '' || pin === id;
}

interface AgentRow {
  id: string;
  name: string;
  projectId: string;
}

interface KeyRow {
  agentId: string;
  key: string | null;
}

export function toAgentSummaries(
  rows: AgentRow[],
  keyRows: KeyRow[],
): AgentSummary[] {
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    owned: true,
    key: keyRows.find((k) => k.agentId === r.id)?.key ?? null,
  }));
}

async function selectKeyRows(ids: string[]): Promise<KeyRow[]> {
  if (ids.length === 0) return [];
  return getDb()
    .select({ agentId: agents.id, key: agents.key })
    .from(agents)
    .where(inArray(agents.id, ids));
}

export async function listAgentsForUser(
  subject: string,
  project: string,
): Promise<AgentSummary[]> {
  const projectId = await projectIdOrThrow(subject, project);
  const rows = await getDb()
    .select({ id: agents.id, name: agents.name, projectId: agents.projectId })
    .from(agents)
    .where(eq(agents.projectId, projectId))
    .orderBy(asc(agents.name), asc(agents.id));
  if (rows.length === 0) return [];
  const keyRows = await selectKeyRows(rows.map((r) => r.id));
  return toAgentSummaries(rows, keyRows);
}

async function insertAgent(
  projectId: string,
  name: string,
  key: string,
): Promise<string> {
  const inserted = await getDb()
    .insert(agents)
    .values({ id: newId(), name, projectId, key })
    .returning({ id: agents.id });
  const id = inserted[0]?.id;
  if (id === undefined)
    throw new AgentAdminError('agent insert returned no id', 500);
  return id;
}

export async function createAgentForUser(
  subject: string,
  project: string,
  rawName: string,
): Promise<CreatedAgent> {
  const name = normalizeAgentName(rawName);
  const key = newApiKey();
  const id = await insertAgent(await projectIdOrThrow(subject, project), name, key);
  if (servesEveryAgent()) registerKey(key, id);
  return { id, name, key };
}

export function parseAgentId(raw: string): string | null {
  return parseId(raw);
}

interface Deletable {
  agent: DeletedAgent;
  projectId: string;
}

export async function ownedAgentOrThrow(
  subject: string,
  id: string,
): Promise<Deletable> {
  const rows = await getDb().select().from(agents).where(eq(agents.id, id));
  const row = rows[0];
  const missing = new AgentAdminError('no such agent', 404);
  if (!row) throw missing;
  try {
    await projectIdOrThrow(subject, row.projectId);
  } catch {
    throw missing;
  }
  return { agent: { id: row.id, name: row.name }, projectId: row.projectId };
}

async function writeNewKey(id: string, projectId: string): Promise<string> {
  for (let attempt = 0; attempt < KEY_ATTEMPTS; attempt += 1) {
    const key = newApiKey();
    try {
      const changed = await getDb()
        .update(agents)
        .set({ key })
        .where(and(eq(agents.id, id), eq(agents.projectId, projectId)))
        .returning({ id: agents.id });
      if (changed.length === 0)
        throw new AgentAdminError('no such agent', 404);
      return key;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new AgentAdminError('could not allocate a free api key', 500);
}

export async function resetAgentKeyForUser(
  subject: string,
  id: string,
): Promise<ResetAgentKey> {
  const { agent, projectId } = await ownedAgentOrThrow(subject, id);
  const key = await writeNewKey(agent.id, projectId);
  rotateAgentKey(agent.id, daemonServesAgent(agent.id) ? key : null);
  return { id: agent.id, name: agent.name, key };
}

export async function deleteAgentForUser(
  subject: string,
  id: string,
): Promise<DeletedAgent> {
  const { agent, projectId } = await ownedAgentOrThrow(subject, id);
  await getDb().transaction(async (tx) => {
    const attached = await tx
      .select({ id: stations.id })
      .from(stations)
      .where(eq(stations.agentId, id));
    if (attached.length > 0)
      throw new AgentAdminError(
        `agent '${agent.name}' still has ${attached.length} station account(s) attached — an operator must remove them first`,
        409,
      );
    const gone = await tx
      .delete(agents)
      .where(and(eq(agents.id, id), eq(agents.projectId, projectId)))
      .returning({ id: agents.id });
    if (gone.length === 0) throw new AgentAdminError('no such agent', 404);
  });
  unregisterAgentKey(id);
  return agent;
}
