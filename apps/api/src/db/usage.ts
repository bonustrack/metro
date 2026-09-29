import { and, eq } from 'drizzle-orm';
import { getDb } from './client.js';
import { agents } from './schema.js';
import { idOf, missing, ownerOf } from './servers.js';

export interface MetricsLink {
  instanceId: string;
  region: string;
  roleArn: string | null;
}

export interface UsageRow {
  host: string;
  link: MetricsLink | null;
}

const usageColumns = {
  host: agents.host,
  instanceId: agents.instanceId,
  launchRegion: agents.launchRegion,
  metricsInstanceId: agents.metricsInstanceId,
  metricsRegion: agents.metricsRegion,
  metricsRoleArn: agents.metricsRoleArn,
};

interface Stored {
  host: string;
  instanceId: string | null;
  launchRegion: string | null;
  metricsInstanceId: string | null;
  metricsRegion: string | null;
  metricsRoleArn: string | null;
}

function linkOf(row: Stored): MetricsLink | null {
  if (row.metricsInstanceId !== null && row.metricsRegion !== null)
    return { instanceId: row.metricsInstanceId, region: row.metricsRegion, roleArn: row.metricsRoleArn };
  if (row.instanceId !== null && row.launchRegion !== null) return { instanceId: row.instanceId, region: row.launchRegion, roleArn: null };
  return null;
}

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

export async function setMetricsLink(rawId: string, link: MetricsLink | null): Promise<void> {
  const changed = await getDb()
    .update(agents)
    .set({ metricsInstanceId: link?.instanceId ?? null, metricsRegion: link?.region ?? null, metricsRoleArn: link?.roleArn ?? null })
    .where(eq(agents.id, idOf(rawId)))
    .returning({ id: agents.id });
  if (changed.length === 0) throw missing();
}
