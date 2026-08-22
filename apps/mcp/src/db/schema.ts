import {
  boolean,
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

export const PROJECT_ROLES = ['admin', 'member'] as const;

export type ProjectRole = (typeof PROJECT_ROLES)[number];

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
});

export const stations = pgTable('stations', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  station: text('station').$type<StationName>().notNull(),
  allowlist: text('allowlist').array().default(['*']),
  config: jsonb('config').notNull(),
});

export const CONNECTOR_TRANSPORTS = ['http', 'sse'] as const;

export type ConnectorTransport = (typeof CONNECTOR_TRANSPORTS)[number];

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

export const collections = pgTable(
  'collections',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
  },
  (t) => [
    unique('collections_project_id_name_unique').on(t.projectId, t.name),
  ],
);

export const collectionItems = pgTable(
  'collection_items',
  {
    id: text('id').primaryKey(),
    collectionId: text('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    connectorId: text('connector_id')
      .notNull()
      .references(() => connectors.id, { onDelete: 'cascade' }),
  },
  (t) => [
    unique('collection_items_collection_id_connector_id_unique').on(
      t.collectionId,
      t.connectorId,
    ),
  ],
);
