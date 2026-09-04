import { index, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

import { STATIONS, type ConnectorTransport, type StationName } from './stations.js';

export { STATIONS, type ConnectorTransport, type StationName };

export type ProjectRole = 'admin' | 'member';


export const vaults = pgTable(
  'vaults',
  {
    id: text('id').primaryKey(),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    stations: jsonb('stations').notNull(),
    envelope: jsonb('envelope').notNull(),
    syncedAt: text('synced_at').notNull(),
  },
  (t) => [index('vaults_owner_idx').on(t.owner)],
);

export const servers = pgTable(
  'servers',
  {
    id: text('id').primaryKey(),
    owner: text('owner').notNull(),
    host: text('host').notNull(),
    name: text('name'),
    addedAt: text('added_at').notNull(),
  },
  (t) => [uniqueIndex('servers_owner_host_idx').on(t.owner, t.host), index('servers_owner_idx').on(t.owner)],
);
