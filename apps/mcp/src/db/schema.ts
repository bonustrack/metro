import {
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
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

export const whatsappAuth = pgTable(
  'whatsapp_auth',
  {
    accountId: text('account_id').notNull(),
    category: text('category').notNull(),
    itemId: text('item_id').notNull().default(''),
    value: jsonb('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.category, t.itemId] })],
);
