import {
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
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
  name: text('name').primaryKey(),
});

export const accounts = pgTable(
  'accounts',
  {
    agent: text('agent').notNull(),
    station: stationEnum('station').notNull(),
    accountId: text('account_id').notNull(),
    config: jsonb('config').notNull(),
  },
  (t) => [primaryKey({ columns: [t.station, t.accountId] })],
);
