import { and, eq } from 'drizzle-orm';
import { getDb } from './client.js';
import { agents } from './schema.js';
import { idOf, missing, ownerOf } from './servers.js';

export interface MetricsLink {
  instanceId: string;
  region: string;
}

export interface UsageRow {
  host: string;
  link: MetricsLink | null;
}

const usageColumns = {
  host: agents.host,
  instanceId: agents.instanceId,
  launchRegion: agents.launchRegion,
};

interface Stored {
  host: string;
  instanceId: string | null;
  launchRegion: string | null;
}

const linkOf = (row: Stored): MetricsLink | null =>
  row.instanceId !== null && row.launchRegion !== null ? { instanceId: row.instanceId, region: row.launchRegion } : null;

export async function usageRowForOwner(subject: string, rawId: string): Promise<UsageRow> {
  const owner = ownerOf(subject);
  const rows = await getDb()
    .select(usageColumns)
    .from(agents)
    .where(and(eq(agents.id, idOf(rawId)), eq(agents.owner, owner)));
  const row = rows[0];
  if (row === undefined) throw missing();
  return { host: row.host, link: linkOf(row) };
}

export interface LinkedRow {
  id: string;
  link: MetricsLink | null;
}

export async function usageRowsForOwner(subject: string): Promise<LinkedRow[]> {
  const rows = await getDb()
    .select({ id: agents.id, ...usageColumns })
    .from(agents)
    .where(eq(agents.owner, ownerOf(subject)));
  return rows.map((row) => ({ id: row.id, link: linkOf(row) }));
}
