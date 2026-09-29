import { index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

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
