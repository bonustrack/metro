import { index, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';

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
    avatar: text('avatar'),
    slug: text('slug'),
    awsConnection: text('aws_connection'),
  },
  (t) => [uniqueIndex('agents_owner_host_idx').on(t.owner, t.host), uniqueIndex('agents_owner_slug_idx').on(t.owner, t.slug), index('agents_owner_idx').on(t.owner)],
);

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  avatar: text('avatar'),
  updatedAt: text('updated_at').notNull(),
  email: text('email'),
  name: text('name'),
  picture: text('picture'),
  createdAt: text('created_at'),
  lastLoginAt: text('last_login_at'),
  status: text('status'),
});

export const organizations = pgTable(
  'organizations',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('organizations_slug_idx').on(t.slug)],
);

export const awsConnections = pgTable(
  'aws_connections',
  {
    id: text('id').primaryKey(),
    owner: text('owner').notNull(),
    accountId: text('account_id').notNull(),
    roleArn: text('role_arn').notNull(),
    addedAt: text('added_at').notNull(),
  },
  (t) => [uniqueIndex('aws_connections_owner_account_idx').on(t.owner, t.accountId)],
);

export const awsExternalIds = pgTable('aws_external_ids', {
  owner: text('owner').primaryKey(),
  externalId: text('external_id').notNull(),
  createdAt: text('created_at').notNull(),
});

export const connectors = pgTable(
  'connectors',
  {
    id: text('id').primaryKey(),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    url: text('url').notNull(),
    auth: text('auth').notNull(),
    policy: text('policy'),
    secret: text('secret'),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('connectors_owner_name_idx').on(t.owner, t.name), index('connectors_owner_idx').on(t.owner)],
);

export const connectorAgents = pgTable(
  'connector_agents',
  {
    connector: text('connector').notNull().references(() => connectors.id, { onDelete: 'cascade' }),
    agent: text('agent').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    policy: text('policy'),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.connector, t.agent] }), index('connector_agents_agent_idx').on(t.agent)],
);

export const connectorEvents = pgTable(
  'connector_events',
  {
    id: text('id').primaryKey(),
    owner: text('owner').notNull(),
    connector: text('connector'),
    agent: text('agent'),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    detail: text('detail'),
    at: text('at').notNull(),
  },
  (t) => [index('connector_events_owner_at_idx').on(t.owner, t.at)],
);

export const boxKeys = pgTable(
  'box_keys',
  {
    agent: text('agent').primaryKey().references(() => agents.id, { onDelete: 'cascade' }),
    owner: text('owner').notNull(),
    keyId: text('key_id').notNull(),
    signingKey: text('signing_key').notNull(),
    sealingKey: text('sealing_key').notNull(),
    enrolledBy: text('enrolled_by').notNull(),
    enrolledAt: text('enrolled_at').notNull(),
  },
  (t) => [uniqueIndex('box_keys_key_id_idx').on(t.keyId)],
);
