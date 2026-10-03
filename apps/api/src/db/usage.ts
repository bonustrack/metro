import { and, eq } from 'drizzle-orm';
import { getDb } from './client.js';
import { agents, awsConnections, awsExternalIds } from './schema.js';
import { idOf, missing, ownerOf } from './servers.js';
import { connectionJoin, externalIdJoin, placedColumns, placementOf, type Placement } from './aws.js';

export type MetricsLink = Placement;

export interface UsageRow {
  host: string;
  link: MetricsLink | null;
}

export async function usageRowForOwner(subject: string, rawId: string): Promise<UsageRow> {
  const owner = ownerOf(subject);
  const rows = await getDb()
    .select({ host: agents.host, ...placedColumns })
    .from(agents)
    .leftJoin(awsConnections, connectionJoin)
    .leftJoin(awsExternalIds, externalIdJoin)
    .where(and(eq(agents.id, idOf(rawId)), eq(agents.owner, owner)));
  const row = rows[0];
  if (row === undefined) throw missing();
  return { host: row.host, link: placementOf(row) };
}

export interface LinkedRow {
  id: string;
  link: MetricsLink | null;
}

export async function usageRowsForOwner(subject: string): Promise<LinkedRow[]> {
  const rows = await getDb()
    .select({ id: agents.id, ...placedColumns })
    .from(agents)
    .leftJoin(awsConnections, connectionJoin)
    .leftJoin(awsExternalIds, externalIdJoin)
    .where(eq(agents.owner, ownerOf(subject)));
  return rows.map((row) => ({ id: row.id, link: placementOf(row) }));
}
