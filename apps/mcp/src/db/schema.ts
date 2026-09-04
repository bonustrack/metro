import { index, jsonb, pgTable, text } from 'drizzle-orm/pg-core';

import { STATIONS, type ConnectorTransport, type StationName } from './stations.js';

export { STATIONS, type ConnectorTransport, type StationName };

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').unique(),
  address: text('address').unique(),
});

export type ProjectRole = 'admin' | 'member';


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
