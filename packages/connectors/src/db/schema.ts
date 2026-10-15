import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';

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
    detail: text('detail'),
    authGeneration: text('auth_generation'),
  },
  (t) => [index('connectors_owner_idx').on(t.owner)],
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

export const agentKeys = pgTable(
  'agent_keys',
  {
    agent: text('agent').primaryKey().references(() => agents.id, { onDelete: 'cascade' }),
    owner: text('owner').notNull(),
    keyId: text('key_id').notNull(),
    signingKey: text('signing_key').notNull(),
    enrolledBy: text('enrolled_by').notNull(),
    enrolledAt: text('enrolled_at').notNull(),
    mcpTokenHash: text('mcp_token_hash'),
  },
  (t) => [uniqueIndex('agent_keys_key_id_idx').on(t.keyId), uniqueIndex('agent_keys_mcp_token_hash_idx').on(t.mcpTokenHash).where(sql`${t.mcpTokenHash} IS NOT NULL`)],
);

export const agentNonces = pgTable(
  'agent_nonces',
  {
    keyId: text('key_id').notNull(),
    nonce: text('nonce').notNull(),
    owner: text('owner').notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.keyId, t.nonce] }), index('agent_nonces_owner_idx').on(t.owner), index('agent_nonces_expiry_idx').on(t.expiresAt)],
);

export const agentNonceGuard = pgTable('agent_nonce_guard', { id: text('id').primaryKey() });

export const mcpApprovals = pgTable(
  'mcp_approvals',
  {
    id: text('id').primaryKey(),
    owner: text('owner').notNull(),
    agent: text('agent').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    connector: text('connector').notNull(),
    tool: text('tool').notNull(),
    argsDigest: text('args_digest').notNull(),
    preview: text('preview').notNull(),
    state: text('state').notNull(),
    requestedAt: bigint('requested_at', { mode: 'number' }).notNull(),
    answeredAt: bigint('answered_at', { mode: 'number' }),
    deliveredAt: bigint('delivered_at', { mode: 'number' }),
  },
  (t) => [
    index('mcp_approvals_agent_state_idx').on(t.agent, t.state),
    uniqueIndex('mcp_approvals_pending_idx').on(t.agent, t.connector, t.tool, t.argsDigest).where(sql`${t.state} = 'pending'`),
  ],
);

export const modelConnections = pgTable(
  'model_connections',
  {
    id: text('id').primaryKey(),
    owner: text('owner').notNull(),
    provider: text('provider').notNull(),
    label: text('label').notNull(),
    model: text('model').notNull().default(''),
    region: text('region').notNull().default(''),
    zdr: boolean('zdr').notNull().default(false),
    secret: text('secret'),
    detail: text('detail'),
    revision: integer('revision').notNull().default(1),
    importAgent: text('import_agent'),
    importId: text('import_id'),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('model_connections_owner_idx').on(t.owner), uniqueIndex('model_connections_import_idx').on(t.importAgent, t.importId)],
);

export const modelRoutes = pgTable(
  'model_routes',
  {
    id: text('id').primaryKey(),
    owner: text('owner').notNull(),
    agent: text('agent').references(() => agents.id, { onDelete: 'cascade' }),
    route: text('route').notNull(),
    updatedBy: text('updated_by').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('model_routes_default_idx').on(t.owner).where(sql`${t.agent} IS NULL`),
    uniqueIndex('model_routes_agent_idx').on(t.agent).where(sql`${t.agent} IS NOT NULL`),
  ],
);

export const modelHosts = pgTable('model_hosts', {
  owner: text('owner').primaryKey(),
  chatgptHostId: text('chatgpt_host_id').notNull(),
});
