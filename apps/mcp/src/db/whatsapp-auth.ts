import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { getDb } from './client.js';
import { whatsappAuth } from './schema.js';

export interface WhatsappAuthRow {
  category: string;
  itemId: string;
  value: unknown;
}

export interface WhatsappAuthRef {
  category: string;
  itemId: string;
}

export async function readWhatsappAuth(
  accountId: string,
  category: string,
  itemIds: string[],
): Promise<Map<string, unknown>> {
  if (itemIds.length === 0) return new Map();
  const db = getDb();
  const rows = await db
    .select({ itemId: whatsappAuth.itemId, value: whatsappAuth.value })
    .from(whatsappAuth)
    .where(
      and(
        eq(whatsappAuth.accountId, accountId),
        eq(whatsappAuth.category, category),
        inArray(whatsappAuth.itemId, itemIds),
      ),
    );
  return new Map(rows.map((r) => [r.itemId, r.value]));
}

export async function writeWhatsappAuth(
  accountId: string,
  rows: WhatsappAuthRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const db = getDb();
  await db
    .insert(whatsappAuth)
    .values(
      rows.map((r) => ({
        accountId,
        category: r.category,
        itemId: r.itemId,
        value: r.value,
      })),
    )
    .onConflictDoUpdate({
      target: [
        whatsappAuth.accountId,
        whatsappAuth.category,
        whatsappAuth.itemId,
      ],
      set: { value: sql`excluded.value`, updatedAt: sql`now()` },
    });
}

export async function deleteWhatsappAuth(
  accountId: string,
  refs: WhatsappAuthRef[],
): Promise<void> {
  if (refs.length === 0) return;
  const db = getDb();
  await db.delete(whatsappAuth).where(
    and(
      eq(whatsappAuth.accountId, accountId),
      or(
        ...refs.map((r) =>
          and(
            eq(whatsappAuth.category, r.category),
            eq(whatsappAuth.itemId, r.itemId),
          ),
        ),
      ),
    ),
  );
}

export async function countWhatsappAuth(accountId: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(whatsappAuth)
    .where(eq(whatsappAuth.accountId, accountId));
  return rows[0]?.n ?? 0;
}
