import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { METRO_VERSION } from '@metro-labs/core/version';
import { MCP_APPROVAL_WAIT_MS, MCP_INBOX_WAIT_MS } from '@metro-labs/http/mcp-server-protocol';
import { AgentAuth } from '@metro-labs/connectors/agent-auth';
import { Favicons } from '@metro-labs/connectors/favicons';
import { agentKeyStore } from '@metro-labs/connectors/db/agent-keys';
import { agentNonceStore } from '@metro-labs/connectors/db/agent-nonces';
import { connectorDeliveryStore } from '@metro-labs/connectors/db/connector-delivery';
import { eventStore } from '@metro-labs/connectors/db/connector-events';
import { subscriptionStore } from '@metro-labs/connectors/db/connector-subscriptions';
import { orgConnectorStore } from '@metro-labs/connectors/db/connectors';
import type { Database } from '@metro-labs/connectors/db/database';
import { approvalStore } from '@metro-labs/connectors/db/mcp-approvals';
import { createAgentToken } from '@metro-labs/connectors/db/agent-tokens';
import { openGrant, redeemGrant, type ApprovedGrant } from '@metro-labs/connectors/db/oauth-grants';
import { log } from '@metro-labs/core/log';
import { callRecorder } from './call-log.js';
import { handleDaemonRequest } from './daemon-api.js';
import type { McpDeps } from './deps.js';
import { Flights } from './flights.js';
import { handleMcpRequest, sendBody } from './mcp-http.js';
import { FIRST_LIST_WAIT_MS } from './listing.js';
import { clientKeyOf } from './oauth/clients.js';
import type { OauthDeps } from './oauth/flow.js';
import { handleOauthRequest } from './oauth/routes.js';
import { Receivers } from './receivers.js';
import { tokenStore } from './token.js';
import { ToolLists } from './tool-lists.js';
import { Waiters } from './waiters.js';
import { handleReceiverDocument, handleWebhookRequest } from './webhook.js';

const APPROVAL_POLL_MS = 1000;
const INBOX_CHECK_MS = 5000;

interface AppSetup {
  key: Buffer;
  db: () => Database;
  publicHost: string;
  appUrl: string;
  fetch: FetchLike;
  callFetch: FetchLike;
  now?: () => number;
}

function oauthDeps(setup: AppSetup, now: () => number): OauthDeps {
  const mint = async (grant: ApprovedGrant, at: number): Promise<string> => {
    const made = await createAgentToken(setup.db(), { owner: grant.owner, agent: grant.agent, label: grant.clientName, createdBy: grant.createdBy, now: at, scopes: ['connectors'] });
    log.info({ owner: grant.owner, agent: grant.agent, token: made.row.id, by: grant.createdBy }, 'mcp: an access key was made for an app that signed in');
    return made.token;
  };
  return {
    issuer: `https://${setup.publicHost}`,
    appUrl: setup.appUrl,
    clientKey: clientKeyOf(setup.key),
    open: (request, at) => openGrant(setup.db(), request, at),
    redeem: (code, at) => redeemGrant(setup.db(), code, at),
    mint,
    now,
  };
}

export function mcpDeps(setup: AppSetup): McpDeps {
  const now = setup.now ?? Date.now;
  const subscriptions = subscriptionStore(setup.db);
  return {
    key: setup.key,
    publicHost: setup.publicHost,
    tokens: tokenStore(setup.db, now),
    oauth: oauthDeps(setup, now),
    keys: agentKeyStore(setup.db),
    nonces: agentNonceStore(setup.db, now),
    auth: new AgentAuth(setup.publicHost, now),
    store: connectorDeliveryStore(setup.db),
    approvals: approvalStore(setup.db),
    subscriptions,
    events: eventStore(setup.db),
    receivers: new Receivers(setup.key, subscriptions, now),
    catalogue: { key: () => setup.key, store: orgConnectorStore(setup.db), fetch: setup.fetch, now },
    calls: callRecorder(setup.db),
    waiters: new Waiters(),
    toolLists: new ToolLists(setup.db, now),
    favicons: new Favicons(setup.fetch, now),
    refreshes: new Flights(),
    fetch: setup.fetch,
    callFetch: setup.callFetch,
    now,
    listWaitMs: FIRST_LIST_WAIT_MS,
    approvalHoldMs: MCP_APPROVAL_WAIT_MS,
    approvalPollMs: APPROVAL_POLL_MS,
    inboxHoldMs: MCP_INBOX_WAIT_MS,
    inboxCheckMs: INBOX_CHECK_MS,
  };
}

function handleHealth(req: IncomingMessage, res: ServerResponse): boolean {
  const path = (req.url ?? '').split('?')[0];
  if (path !== '/health' && path !== '/healthz') return false;
  sendBody(res, 200, { status: 'ok', version: METRO_VERSION, uptime: Math.round(process.uptime()) });
  return true;
}

export function handleRequest(req: IncomingMessage, res: ServerResponse, deps: McpDeps): void {
  if (handleHealth(req, res) || handleReceiverDocument(req, res) || handleWebhookRequest(req, res, deps)) return;
  if (handleOauthRequest(req, res, deps.oauth) || handleDaemonRequest(req, res, deps) || handleMcpRequest(req, res, deps)) return;
  sendBody(res, 404, { error: 'not found' });
}
