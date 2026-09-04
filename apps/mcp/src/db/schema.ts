import { boolean, index, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core';

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

export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ownerId: text('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  isDefault: boolean('is_default').notNull().default(false),
});

export const projectMembers = pgTable(
  'project_members',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    role: text('role').$type<ProjectRole>().notNull(),
  },
  (t) => [unique('project_members_project_id_user_id_unique').on(t.projectId, t.userId)],
);

export const agents = pgTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'restrict' }),
  key: text('key').unique(),
  runtimeId: text('runtime_id'),
});

export const runtimes = pgTable('runtimes', {
  id: text('id').primaryKey(),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  createdAt: text('created_at').notNull(),
  lastSeenAt: text('last_seen_at'),
  revokedAt: text('revoked_at'),
});

export const stations = pgTable('stations', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  station: text('station').$type<StationName>().notNull(),
  allowlist: text('allowlist').array().default(['*']),
  config: jsonb('config').notNull(),
});


export type ConnectorTransport = 'http' | 'sse';

export const connectors = pgTable(
  'connectors',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    url: text('url').notNull(),
    transport: text('transport').$type<ConnectorTransport>().notNull(),
    config: jsonb('config').notNull(),
  },
);

export const agentConnectors = pgTable(
  'agent_connectors',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    connectorId: text('connector_id')
      .notNull()
      .references(() => connectors.id, { onDelete: 'cascade' }),
  },
  (t) => [
    unique('agent_connectors_agent_id_connector_id_unique').on(
      t.agentId,
      t.connectorId,
    ),
  ],
);

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
