import { and, eq, isNotNull } from 'drizzle-orm';
import { errMsg, log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { MCP_TOKEN_RE } from '@metro-labs/http/mcp-server-protocol';
import { notEnrolled } from '@metro-labs/connectors/agent-auth';
import type { AgentKeyRow } from '@metro-labs/connectors/db/agent-keys';
import { findAgentToken, touchAgentToken, type AgentTokenIdentity } from '@metro-labs/connectors/db/agent-tokens';
import type { DeliveryIdentity } from '@metro-labs/connectors/db/connector-delivery';
import type { Database } from '@metro-labs/connectors/db/database';
import { isUndefinedTable, isUniqueViolation } from '@metro-labs/connectors/db/errors';
import { agentKeys, agents } from '@metro-labs/connectors/db/schema';

export interface TokenStore {
  agentOf: (tokenHash: string) => Promise<DeliveryIdentity | null>;
  setHash: (identity: AgentKeyRow, tokenHash: string) => Promise<void>;
}

const BEARER = 'Bearer ';
export const TOUCH_EVERY_MS = 60_000;
const TOUCHED_MAX = 10_000;

export function bearerToken(header: string | undefined): string | null {
  if (header === undefined || !header.startsWith(BEARER)) return null;
  const token = header.slice(BEARER.length).trim();
  return MCP_TOKEN_RE.test(token) ? token : null;
}

const identityColumns = {
  agent: agentKeys.agent,
  owner: agentKeys.owner,
  keyId: agentKeys.keyId,
  signingKey: agentKeys.signingKey,
  enrolledBy: agentKeys.enrolledBy,
  enrolledAt: agentKeys.enrolledAt,
};

class Touches {
  private readonly last = new Map<string, number>();
  private quiet = false;

  constructor(
    private readonly db: () => Database,
    private readonly now: () => number,
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
      log.warn({ err: errMsg(err) }, 'mcp: could not note when an access key was last used, later failures stay quiet until one works');
    });
  }

  private forgetOld(now: number): void {
    for (const [id, at] of this.last) if (now - at >= TOUCH_EVERY_MS) this.last.delete(id);
    if (this.last.size >= TOUCHED_MAX) this.last.clear();
  }
}

async function boxOf(db: Database, tokenHash: string): Promise<AgentKeyRow | null> {
  const rows = await db
    .select(identityColumns)
    .from(agentKeys)
    .innerJoin(agents, and(eq(agents.id, agentKeys.agent), eq(agents.owner, agentKeys.owner), isNotNull(agents.host)))
    .where(eq(agentKeys.mcpTokenHash, tokenHash))
    .limit(1);
  return rows[0] ?? null;
}

function accessKeys(db: () => Database): (tokenHash: string) => Promise<AgentTokenIdentity | null> {
  let waiting = false;
  return async (tokenHash) => {
    try {
      const found = await findAgentToken(db(), tokenHash);
      waiting = false;
      return found;
    } catch (err) {
      if (!isUndefinedTable(err)) throw err;
      if (!waiting) log.warn('mcp: the agent_tokens table does not exist yet, so access keys are refused until api.metro.box migrates');
      waiting = true;
      return null;
    }
  };
}

export function tokenStore(db: () => Database, now: () => number = Date.now): TokenStore {
  const touches = new Touches(db, now);
  const accessKeyOf = accessKeys(db);
  return {
    agentOf: async (tokenHash) => {
      const box = await boxOf(db(), tokenHash);
      if (box !== null) return box;
      const remote = await accessKeyOf(tokenHash);
      if (remote === null || !remote.scopes.includes('connectors')) return null;
      touches.note(remote.tokenId);
      return remote;
    },
    setHash: async (identity, tokenHash) => {
      try {
        const saved = await db()
          .update(agentKeys)
          .set({ mcpTokenHash: tokenHash })
          .where(and(eq(agentKeys.agent, identity.agent), eq(agentKeys.owner, identity.owner), eq(agentKeys.keyId, identity.keyId)))
          .returning({ agent: agentKeys.agent });
        if (saved.length === 0) throw notEnrolled();
      } catch (err) {
        if (isUniqueViolation(err)) throw new ApiError('This MCP token is already in use. Make a new one.', 409);
        throw err;
      }
    },
  };
}
