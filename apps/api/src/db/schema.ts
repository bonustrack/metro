import { sql } from 'drizzle-orm';
import { bigint, index, integer, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { agents, organizations } from '@metro-labs/connectors/db/schema';

export * from '@metro-labs/connectors/db/schema';

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    avatar: text('avatar'),
    updatedAt: text('updated_at').notNull(),
    email: text('email'),
    name: text('name'),
    picture: text('picture'),
    createdAt: text('created_at'),
    lastLoginAt: text('last_login_at'),
    status: text('status'),
    lastOrganization: text('last_organization'),
  },
  (t) => [uniqueIndex('users_email_idx').on(sql`lower(${t.email})`)],
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

export const memberships = pgTable(
  'memberships',
  {
    id: text('id').primaryKey(),
    organization: text('organization').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<'admin' | 'member'>().notNull(),
    addedBy: text('added_by'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [uniqueIndex('memberships_organization_user_idx').on(t.organization, t.userId), index('memberships_user_idx').on(t.userId)],
);

export const identities = pgTable(
  'identities',
  {
    provider: text('provider').$type<'google' | 'microsoft'>().notNull(),
    subject: text('subject').notNull(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    lastUsedAt: bigint('last_used_at', { mode: 'number' }),
  },
  (t) => [primaryKey({ columns: [t.provider, t.subject] }), index('identities_user_idx').on(t.userId)],
);

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    method: text('method').$type<'google' | 'microsoft'>().notNull(),
    refreshHash: text('refresh_hash').notNull(),
    previousHash: text('previous_hash'),
    rotatedAt: bigint('rotated_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    lastUsedAt: bigint('last_used_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    revokedAt: bigint('revoked_at', { mode: 'number' }),
  },
  (t) => [
    uniqueIndex('auth_sessions_refresh_hash_idx').on(t.refreshHash),
    index('auth_sessions_previous_hash_idx').on(t.previousHash).where(sql`${t.previousHash} IS NOT NULL`),
    index('auth_sessions_user_idx').on(t.userId),
    index('auth_sessions_expires_idx').on(t.expiresAt),
  ],
);

export const authSpentTokens = pgTable(
  'auth_spent_tokens',
  {
    hash: text('hash').primaryKey(),
    session: text('session').notNull().references(() => authSessions.id, { onDelete: 'cascade' }),
    spentAt: bigint('spent_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('auth_spent_tokens_session_idx').on(t.session)],
);

export const chats = pgTable(
  'chats',
  {
    id: text('id').primaryKey(),
    owner: text('owner').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    agent: text('agent').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    createdBy: text('created_by').notNull(),
    title: text('title').notNull(),
    shared: text('shared').$type<'private' | 'organization'>().notNull().default('private'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('chats_owner_updated_idx').on(t.owner, t.updatedAt.desc(), t.id), index('chats_agent_idx').on(t.agent)],
);

export const chatMembers = pgTable(
  'chat_members',
  {
    chat: text('chat').notNull().references(() => chats.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    addedBy: text('added_by').notNull(),
    addedAt: bigint('added_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.chat, t.userId] }), index('chat_members_user_idx').on(t.userId)],
);

export const chatPins = pgTable(
  'chat_pins',
  {
    userId: text('user_id').notNull(),
    chat: text('chat').notNull().references(() => chats.id, { onDelete: 'cascade' }),
    pinnedAt: bigint('pinned_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.chat] }), index('chat_pins_chat_idx').on(t.chat)],
);

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: text('id').primaryKey(),
    chat: text('chat').notNull().references(() => chats.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    role: text('role').$type<'user' | 'assistant'>().notNull(),
    author: text('author'),
    replyTo: text('reply_to'),
    body: text('body').notNull(),
    at: bigint('at', { mode: 'number' }).notNull(),
  },
  (t) => [uniqueIndex('chat_messages_seq_idx').on(t.chat, t.seq), uniqueIndex('chat_messages_reply_idx').on(t.chat, t.replyTo)],
);

export const chatReads = pgTable(
  'chat_reads',
  {
    chat: text('chat').notNull().references(() => chats.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    seenSeq: integer('seen_seq').notNull(),
  },
  (t) => [primaryKey({ columns: [t.chat, t.userId] })],
);
