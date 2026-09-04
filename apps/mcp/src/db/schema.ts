import { index, jsonb, pgTable, text } from 'drizzle-orm/pg-core';

export const STATIONS = [
  'xmtp',
  'telegram-bot',
  'telegram',
  'discord-bot',
  'whatsapp',
  'webhook',
] as const;

export type StationName = (typeof STATIONS)[number];

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').unique(),
  address: text('address').unique(),
});

export type ProjectRole = 'admin' | 'member';

export type ConnectorTransport = 'http' | 'sse';

export const vault = pgTable(
  'vault',
  {
    id: text('id').primaryKey(),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    stations: jsonb('stations').notNull(),
    envelope: jsonb('envelope').notNull(),
    syncedAt: text('synced_at').notNull(),
  },
  (t) => [index('vault_owner_idx').on(t.owner)],
);
