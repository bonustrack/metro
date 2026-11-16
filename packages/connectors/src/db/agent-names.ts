import { and, eq } from 'drizzle-orm';
import type { Database } from './database.js';
import { agents, organizations } from './schema.js';

export interface AgentNames {
  organizationSlug: string | null;
  agentSlug: string | null;
  agentName: string | null;
}

const NONE: AgentNames = { organizationSlug: null, agentSlug: null, agentName: null };

export async function agentNames(db: Database, owner: string, agent: string): Promise<AgentNames> {
  const rows = await db
    .select({ organizationSlug: organizations.slug, agentSlug: agents.slug, agentName: agents.name })
    .from(agents)
    .leftJoin(organizations, eq(organizations.id, agents.owner))
    .where(and(eq(agents.id, agent), eq(agents.owner, owner)))
    .limit(1);
  return rows[0] ?? NONE;
}
