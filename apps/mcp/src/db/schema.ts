import {
  jsonb,
  pgTable,
  text,
  unique,
} from 'drizzle-orm/pg-core';

export const STATIONS = [
  'xmtp',
  'telegram',
  'telegram-user',
  'discord',
  'whatsapp',
  'webhook',
] as const;

export type StationName = (typeof STATIONS)[number];

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
});

export const agents = pgTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ownerId: text('owner_id').references(() => users.id, {
    onDelete: 'restrict',
  }),
  key: text('key').unique(),
});

export const stations = pgTable(
  'stations',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    station: text('station').$type<StationName>().notNull(),
    accountId: text('account_id').notNull(),
    allowlist: text('allowlist').array().default(['*']),
    config: jsonb('config').notNull(),
  },
  (t) => [unique('stations_station_account_id_unique').on(t.station, t.accountId)],
);

export const CONNECTOR_TRANSPORTS = ['http', 'sse'] as const;

export type ConnectorTransport = (typeof CONNECTOR_TRANSPORTS)[number];

export const connectors = pgTable(
  'connectors',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    url: text('url').notNull(),
    transport: text('transport').$type<ConnectorTransport>().notNull(),
    config: jsonb('config').notNull(),
  },
  (t) => [unique('connectors_user_id_name_unique').on(t.userId, t.name)],
);
