import type { FetchLike } from '@metro-labs/core/stations/oauth';
import type { RemoteTool } from '@metro-labs/http/connector-tools';
import type { AgentAuth } from '@metro-labs/connectors/agent-auth';
import type { AgentKeyStore } from '@metro-labs/connectors/db/agent-keys';
import type { AgentNonceStore } from '@metro-labs/connectors/db/agent-nonces';
import type { ConnectorDeliveryStore } from '@metro-labs/connectors/db/connector-delivery';
import type { ApprovalStore } from './approvals.js';
import type { Flights, ToolCache } from './flights.js';
import type { TokenStore } from './token.js';
import type { Waiters } from './waiters.js';

export interface McpDeps {
  key: Buffer;
  tokens: TokenStore;
  keys: Pick<AgentKeyStore, 'find'>;
  nonces: AgentNonceStore;
  auth: AgentAuth;
  store: Pick<ConnectorDeliveryStore, 'assigned' | 'refresh'>;
  approvals: ApprovalStore;
  waiters: Waiters;
  tools: ToolCache<RemoteTool[]>;
  listings: Flights<RemoteTool[]>;
  refreshes: Flights<undefined>;
  fetch: FetchLike;
  callFetch: FetchLike;
  now: () => number;
  approvalHoldMs: number;
  approvalPollMs: number;
}
