import {
  integer,
  jsonb,
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
  'whatsapp',
] as const;

export type StationName = (typeof STATIONS)[number];

export const agents = pgTable('agents', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
});

export const accounts = pgTable(
  'accounts',
  {
    agentId: integer('agent_id').notNull(),
    station: text('station').$type<StationName>().notNull(),
    accountId: text('account_id').notNull(),
    allowlist: text('allowlist').array().default(['*']),
    config: jsonb('config').notNull(),
    credentials: jsonb('credentials'),
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
