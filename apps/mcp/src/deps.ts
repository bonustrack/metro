import type { FetchLike } from '@metro-labs/core/stations/oauth';
import type { AgentAuth } from '@metro-labs/connectors/agent-auth';
import type { AgentKeyStore } from '@metro-labs/connectors/db/agent-keys';
import type { AgentNonceStore } from '@metro-labs/connectors/db/agent-nonces';
import type { ConnectorDeliveryStore } from '@metro-labs/connectors/db/connector-delivery';
import type { ApprovalStore } from '@metro-labs/connectors/db/mcp-approvals';
import type { CallRecorder } from './call-log.js';
import type { Flights } from './flights.js';
import type { Favicons } from '@metro-labs/connectors/favicons';
import type { TokenStore } from './token.js';
import type { ToolLists } from './tool-lists.js';
import type { Waiters } from './waiters.js';

export interface McpDeps {
  key: Buffer;
  tokens: TokenStore;
  keys: Pick<AgentKeyStore, 'find'>;
  nonces: AgentNonceStore;
  auth: AgentAuth;
  store: Pick<ConnectorDeliveryStore, 'assigned' | 'refresh'>;
  approvals: ApprovalStore;
  calls: CallRecorder;
  waiters: Waiters;
  toolLists: ToolLists;
  favicons: Favicons;
  refreshes: Flights<undefined>;
  fetch: FetchLike;
  callFetch: FetchLike;
  now: () => number;
  listWaitMs: number;
  approvalHoldMs: number;
  approvalPollMs: number;
}
