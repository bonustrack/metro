import { index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

import { STATIONS, type ConnectorTransport, type StationName } from '@metro-labs/core/station-names';

export { STATIONS, type ConnectorTransport, type StationName };

export type ProjectRole = 'admin' | 'member';


export const agents = pgTable(
  'agents',
  {
    id: text('id').primaryKey(),
    owner: text('owner').notNull(),
    host: text('host').notNull(),
    name: text('name'),
    addedAt: text('added_at').notNull(),
    instanceId: text('instance_id'),
    launchRegion: text('launch_region'),
    launchedAt: text('launched_at'),
  },
  (t) => [uniqueIndex('agents_owner_host_idx').on(t.owner, t.host), index('agents_owner_idx').on(t.owner)],
);
