import {
  bigint,
  index,
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
  'line',
] as const;

export type StationName = (typeof STATIONS)[number];

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
});

export const agents = pgTable('agents', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  ownerId: integer('owner_id').references(() => users.id, {
    onDelete: 'restrict',
  }),
  key: text('key').unique(),
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

export const RUN_STATES = ['running', 'done', 'lost'] as const;

export type RunState = (typeof RUN_STATES)[number];

export const agentRuns = pgTable(
  'agent_runs',
  {
    agentId: integer('agent_id').notNull(),
    runId: text('run_id').notNull(),
    agentType: text('agent_type'),
    label: text('label'),
    state: text('state').$type<RunState>().notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    turns: integer('turns').notNull().default(0),
    inputTokens: bigint('input_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.runId] }),
    index('agent_runs_started_idx').on(t.agentId, t.startedAt),
  ],
);

export const ROW_KINDS = ['agent', 'queue'] as const;

export type RowKind = (typeof ROW_KINDS)[number];

export interface ReportRow {
  kind: RowKind;
  id: string;
  state: string;
  label: string | null;
  who: string | null;
  needs: string[];
  blockedOn: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

export const agentReports = pgTable('agent_reports', {
  agentId: integer('agent_id').primaryKey(),
  rows: jsonb('rows').$type<ReportRow[]>().notNull(),
  reportedAt: timestamp('reported_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
