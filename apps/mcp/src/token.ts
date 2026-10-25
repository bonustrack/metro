import { and, eq } from 'drizzle-orm';
import { ApiError } from '@metro-labs/http/api-error';
import { MCP_TOKEN_RE } from '@metro-labs/http/mcp-server-protocol';
import { notEnrolled } from '@metro-labs/connectors/agent-auth';
import type { AgentKeyRow } from '@metro-labs/connectors/db/agent-keys';
import type { DeliveryIdentity } from '@metro-labs/connectors/db/connector-delivery';
import type { Database } from '@metro-labs/connectors/db/database';
import { accessKeyLookup, boxByTokenHash, Touches } from '@metro-labs/connectors/db/bearers';
import { isUniqueViolation } from '@metro-labs/connectors/db/errors';
import { agentKeys } from '@metro-labs/connectors/db/schema';

export interface TokenStore {
  agentOf: (tokenHash: string) => Promise<DeliveryIdentity | null>;
  setHash: (identity: AgentKeyRow, tokenHash: string) => Promise<void>;
}

const BEARER = 'Bearer ';

export function bearerToken(header: string | undefined): string | null {
  if (header === undefined || !header.startsWith(BEARER)) return null;
  const token = header.slice(BEARER.length).trim();
  return MCP_TOKEN_RE.test(token) ? token : null;
}

export function tokenStore(db: () => Database, now: () => number = Date.now): TokenStore {
  const touches = new Touches(db, now, 'mcp');
  const accessKeyOf = accessKeyLookup(db, 'mcp');
  return {
    agentOf: async (tokenHash) => {
      const box = await boxByTokenHash(db(), tokenHash);
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
