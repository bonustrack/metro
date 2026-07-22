import { and, eq } from 'drizzle-orm';
import { getDb } from './client.js';
import { accounts } from './schema.js';

export async function readWhatsappCredentials(
  accountId: string,
): Promise<unknown> {
  const db = getDb();
  const rows = await db
    .select({ credentials: accounts.credentials })
    .from(accounts)
    .where(
      and(eq(accounts.station, 'whatsapp'), eq(accounts.accountId, accountId)),
    )
    .limit(1);
  return rows[0]?.credentials ?? null;
}

export async function writeWhatsappCredentials(
  accountId: string,
  credentials: unknown,
): Promise<void> {
  const db = getDb();
  await db
    .update(accounts)
    .set({ credentials })
    .where(
      and(eq(accounts.station, 'whatsapp'), eq(accounts.accountId, accountId)),
    );
}
