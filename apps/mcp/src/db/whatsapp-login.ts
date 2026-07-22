import { and, eq, sql } from 'drizzle-orm';
import { getDb } from './client.js';
import { accounts } from './schema.js';

export async function writeWhatsappCredentials(
  accountId: string,
  credentials: unknown,
): Promise<void> {
  const db = getDb();
  await db
    .update(accounts)
    .set({
      config: sql`${accounts.config} || ${JSON.stringify({ credentials })}::jsonb`,
    })
    .where(
      and(eq(accounts.station, 'whatsapp'), eq(accounts.accountId, accountId)),
    );
}
