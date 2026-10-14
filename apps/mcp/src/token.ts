import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { ApiError } from '@metro-labs/http/api-error';
import { MCP_TOKEN_RE } from '@metro-labs/http/mcp-server-protocol';
import { notEnrolled } from '@metro-labs/connectors/agent-auth';
import type { AgentKeyRow } from '@metro-labs/connectors/db/agent-keys';
import type { Database } from '@metro-labs/connectors/db/database';
import { isUniqueViolation } from '@metro-labs/connectors/db/errors';
import { agentKeys, agents } from '@metro-labs/connectors/db/schema';

export interface TokenStore {
  agentOf: (tokenHash: string) => Promise<AgentKeyRow | null>;
  setHash: (identity: AgentKeyRow, tokenHash: string) => Promise<void>;
}

const BEARER = 'Bearer ';

export const tokenHashOf = (token: string): string => createHash('sha256').update(token, 'utf8').digest('base64url');

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
  sealingKey: agentKeys.sealingKey,
  enrolledBy: agentKeys.enrolledBy,
  enrolledAt: agentKeys.enrolledAt,
};

export function tokenStore(db: () => Database): TokenStore {
  return {
    agentOf: async (tokenHash) => {
      const rows = await db()
        .select(identityColumns)
        .from(agentKeys)
        .innerJoin(agents, and(eq(agents.id, agentKeys.agent), eq(agents.owner, agentKeys.owner)))
        .where(eq(agentKeys.mcpTokenHash, tokenHash))
        .limit(1);
      return rows[0] ?? null;
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
