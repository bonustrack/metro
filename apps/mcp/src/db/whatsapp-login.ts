import { and, eq, sql } from 'drizzle-orm';
import { getDb } from './client.js';
import { stations } from './schema.js';

export async function writeWhatsappCredentials(
  accountId: string,
  credentials: unknown,
): Promise<void> {
  const db = getDb();
  await db
    .update(stations)
    .set({
      config: sql`${stations.config} || ${JSON.stringify({ credentials })}::jsonb`,
    })
    .where(
      and(eq(stations.station, 'whatsapp'), eq(stations.accountId, accountId)),
    );
}
