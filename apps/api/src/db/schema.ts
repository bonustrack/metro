import { bigint, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

export * from '@metro-labs/connectors/db/schema';

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
    avatar: text('avatar'),
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

export const pushDevices = pgTable(
  'push_devices',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    token: text('token').notNull(),
    platform: text('platform').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    lastSeenAt: bigint('last_seen_at', { mode: 'number' }).notNull(),
  },
  (t) => [uniqueIndex('push_devices_token_idx').on(t.token), index('push_devices_user_idx').on(t.userId, t.lastSeenAt)],
);
