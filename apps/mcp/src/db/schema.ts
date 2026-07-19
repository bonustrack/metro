import {
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
} from 'drizzle-orm/pg-core';

export const STATIONS = [
  'xmtp',
  'telegram',
  'telegram-user',
  'discord',
] as const;

export type StationName = (typeof STATIONS)[number];

export const stationEnum = pgEnum('station', STATIONS);

export const agents = pgTable('agents', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
});

export const accounts = pgTable(
  'accounts',
  {
    agentId: integer('agent_id').notNull(),
    station: stationEnum('station').notNull(),
    accountId: text('account_id').notNull(),
    config: jsonb('config').notNull(),
  },
  (t) => [primaryKey({ columns: [t.station, t.accountId] })],
);

export const keys = pgTable(
  'keys',
  {
    agentId: integer('agent_id').notNull(),
    name: text('name').notNull(),
    key: text('key').notNull(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.name] })],
);
