import { and, eq, isNotNull } from 'drizzle-orm';
import { errMsg, log } from '@metro-labs/core/log';
import type { AgentKeyRow } from './agent-keys.js';
import { findAgentToken, touchAgentToken, type AgentTokenIdentity } from './agent-tokens.js';
import type { Database } from './database.js';
import { isUndefinedTable } from './errors.js';
import { agentKeys, agents } from './schema.js';

export const TOUCH_EVERY_MS = 60_000;
const TOUCHED_MAX = 10_000;

const identityColumns = {
  agent: agentKeys.agent,
  owner: agentKeys.owner,
  keyId: agentKeys.keyId,
  signingKey: agentKeys.signingKey,
  enrolledBy: agentKeys.enrolledBy,
  enrolledAt: agentKeys.enrolledAt,
};

export class Touches {
  private readonly last = new Map<string, number>();
  private quiet = false;

  constructor(
    private readonly db: () => Database,
    private readonly now: () => number,
    private readonly app: string,
  ) {}

  note(id: string): void {
    const now = this.now();
    const seen = this.last.get(id);
    if (seen !== undefined && now - seen < TOUCH_EVERY_MS) return;
    if (this.last.size >= TOUCHED_MAX) this.forgetOld(now);
    this.last.set(id, now);
    touchAgentToken(this.db(), id, now).then(() => {
      this.quiet = false;
    }, (err: unknown) => {
      if (this.quiet) return;
      this.quiet = true;
      log.warn({ err: errMsg(err) }, `${this.app}: could not note when an access key was last used, later failures stay quiet until one works`);
    });
  }

  private forgetOld(now: number): void {
    for (const [id, at] of this.last) if (now - at >= TOUCH_EVERY_MS) this.last.delete(id);
    if (this.last.size >= TOUCHED_MAX) this.last.clear();
  }
}

export async function boxByTokenHash(db: Database, tokenHash: string): Promise<AgentKeyRow | null> {
  const rows = await db
    .select(identityColumns)
    .from(agentKeys)
    .innerJoin(agents, and(eq(agents.id, agentKeys.agent), eq(agents.owner, agentKeys.owner), isNotNull(agents.host)))
    .where(eq(agentKeys.mcpTokenHash, tokenHash))
    .limit(1);
  return rows[0] ?? null;
}

export function accessKeyLookup(db: () => Database, app: string): (tokenHash: string) => Promise<AgentTokenIdentity | null> {
  let waiting = false;
  return async (tokenHash) => {
    try {
      const found = await findAgentToken(db(), tokenHash);
      waiting = false;
      return found;
    } catch (err) {
      if (!isUndefinedTable(err)) throw err;
      if (!waiting) log.warn(`${app}: the agent_tokens table does not exist yet, so access keys are refused until api.metro.box migrates`);
      waiting = true;
      return null;
    }
  };
}
