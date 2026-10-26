import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { METRO_VERSION } from '@metro-labs/core/version';
import { MCP_APPROVAL_WAIT_MS } from '@metro-labs/http/mcp-server-protocol';
import { AgentAuth } from '@metro-labs/connectors/agent-auth';
import { agentKeyStore } from '@metro-labs/connectors/db/agent-keys';
import { agentNonceStore } from '@metro-labs/connectors/db/agent-nonces';
import { connectorDeliveryStore } from '@metro-labs/connectors/db/connector-delivery';
import type { Database } from '@metro-labs/connectors/db/database';
import { approvalStore } from '@metro-labs/connectors/db/mcp-approvals';
import { callRecorder } from './call-log.js';
import { handleDaemonRequest } from './daemon-api.js';
import type { McpDeps } from './deps.js';
import { Flights, ToolCache } from './flights.js';
import { TOOL_LIST_TTL_MS } from './listing.js';
import { handleMcpRequest, sendBody } from './mcp-http.js';
import { tokenStore } from './token.js';
import { Waiters } from './waiters.js';

const APPROVAL_POLL_MS = 1000;

interface AppSetup {
  key: Buffer;
  db: () => Database;
  publicHost: string;
  fetch: FetchLike;
  callFetch: FetchLike;
  now?: () => number;
}

export function mcpDeps(setup: AppSetup): McpDeps {
  const now = setup.now ?? Date.now;
  return {
    key: setup.key,
    tokens: tokenStore(setup.db, now),
    keys: agentKeyStore(setup.db),
    nonces: agentNonceStore(setup.db, now),
    auth: new AgentAuth(setup.publicHost, now),
    store: connectorDeliveryStore(setup.db),
    approvals: approvalStore(setup.db),
    calls: callRecorder(setup.db),
    waiters: new Waiters(),
    tools: new ToolCache(TOOL_LIST_TTL_MS, now),
    listings: new Flights(),
    refreshes: new Flights(),
    fetch: setup.fetch,
    callFetch: setup.callFetch,
    now,
    approvalHoldMs: MCP_APPROVAL_WAIT_MS,
    approvalPollMs: APPROVAL_POLL_MS,
  };
}

function handleHealth(req: IncomingMessage, res: ServerResponse): boolean {
  const path = (req.url ?? '').split('?')[0];
  if (path !== '/health' && path !== '/healthz') return false;
  sendBody(res, 200, { status: 'ok', version: METRO_VERSION, uptime: Math.round(process.uptime()) });
  return true;
}

export function handleRequest(req: IncomingMessage, res: ServerResponse, deps: McpDeps): void {
  if (handleHealth(req, res) || handleDaemonRequest(req, res, deps) || handleMcpRequest(req, res, deps)) return;
  sendBody(res, 404, { error: 'not found' });
}
