import { and, asc, eq } from 'drizzle-orm';
import { ApiError } from '../daemon/api-error.js';
import { isRecord } from '../daemon/is-record.js';
import { getDb } from './client.js';
import { AGENT_NAME_RE, parseId } from './ids.js';
import { STATIONS, vault } from './schema.js';
import { normalizeAddress } from './users.js';

export class VaultError extends ApiError {}

export interface VaultEntry {
  id: string;
  name: string;
  stations: string[];
  syncedAt: string;
}

export interface VaultBundle extends VaultEntry {
  envelope: Record<string, unknown>;
}

export interface VaultInput {
  name: string;
  stations: string[];
  envelope: Record<string, unknown>;
}

export const ENVELOPE_MAX = 2 * 1024 * 1024;
const STATION_NAMES = new Set<string>(STATIONS);

const missing = (): VaultError => new VaultError('no such bundle', 404);

function ownerOf(subject: string): string {
  const address = normalizeAddress(subject);
  if (address === null) throw new VaultError('the vault needs a wallet sign-in', 403);
  return address;
}

function stationsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new VaultError('stations must be a list of station names', 400);
  const list = raw.map((s: unknown) => (typeof s === 'string' ? s : ''));
  const bad = list.find((s) => !STATION_NAMES.has(s));
  if (bad !== undefined) throw new VaultError(`'${bad}' is not a station`, 400);
  return [...new Set(list)];
}

function envelopeOf(raw: unknown, id: string, owner: string): Record<string, unknown> {
  if (!isRecord(raw) || raw.v !== 1 || raw.agentId !== id)
    throw new VaultError('envelope must be a v1 envelope for this agent', 400);
  const key = raw.key;
  if (!isRecord(key) || key.recipient !== owner)
    throw new VaultError('envelope must be sealed to the signed-in wallet', 400);
  if (typeof raw.ciphertext !== 'string' || typeof raw.nonce !== 'string')
    throw new VaultError('envelope carries no ciphertext', 400);
  if (JSON.stringify(raw).length > ENVELOPE_MAX)
    throw new VaultError(`envelope is over ${String(ENVELOPE_MAX)} bytes`, 413);
  return raw;
}

export function parseVaultInput(subject: string, id: string, body: unknown): VaultInput & { owner: string } {
  const owner = ownerOf(subject);
  if (parseId(id) === null) throw missing();
  if (!isRecord(body)) throw new VaultError('body must be an object', 400);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!AGENT_NAME_RE.test(name)) throw new VaultError('name is not an agent name', 400);
  return { owner, name, stations: stationsOf(body.stations), envelope: envelopeOf(body.envelope, id, owner) };
}

const entryOf = (row: { id: string; name: string; stations: unknown; syncedAt: string }): VaultEntry => ({
  id: row.id,
  name: row.name,
  stations: Array.isArray(row.stations) ? row.stations.filter((s): s is string => typeof s === 'string') : [],
  syncedAt: row.syncedAt,
});

export async function listVaultForOwner(subject: string): Promise<VaultEntry[]> {
  const owner = ownerOf(subject);
  const rows = await getDb()
    .select({ id: vault.id, name: vault.name, stations: vault.stations, syncedAt: vault.syncedAt })
    .from(vault)
    .where(eq(vault.owner, owner))
    .orderBy(asc(vault.name));
  return rows.map(entryOf);
}

export async function putVaultForOwner(subject: string, id: string, body: unknown): Promise<VaultEntry> {
  const input = parseVaultInput(subject, id, body);
  const syncedAt = new Date().toISOString();
  const values = { id, owner: input.owner, name: input.name, stations: input.stations, envelope: input.envelope, syncedAt };
  const db = getDb();
  const held = await db.select({ owner: vault.owner }).from(vault).where(eq(vault.id, id));
  if (held[0] !== undefined && held[0].owner !== input.owner) throw missing();
  await db
    .insert(vault)
    .values(values)
    .onConflictDoUpdate({ target: vault.id, set: { name: input.name, stations: input.stations, envelope: input.envelope, syncedAt } });
  return entryOf(values);
}

export async function getVaultForOwner(subject: string, id: string): Promise<VaultBundle> {
  const owner = ownerOf(subject);
  if (parseId(id) === null) throw missing();
  const rows = await getDb().select().from(vault).where(and(eq(vault.id, id), eq(vault.owner, owner)));
  const row = rows[0];
  if (row === undefined) throw missing();
  return { ...entryOf(row), envelope: isRecord(row.envelope) ? row.envelope : {} };
}

export async function deleteVaultForOwner(subject: string, id: string): Promise<{ id: string; name: string }> {
  const owner = ownerOf(subject);
  if (parseId(id) === null) throw missing();
  const gone = await getDb()
    .delete(vault)
    .where(and(eq(vault.id, id), eq(vault.owner, owner)))
    .returning({ id: vault.id, name: vault.name });
  const row = gone[0];
  if (row === undefined) throw missing();
  return row;
}
