import { splitMcpTool, type McpFindRequest } from '@metro-labs/http/mcp-server-protocol';
import type { DeliveryIdentity } from '@metro-labs/connectors/db/connector-delivery';
import { agentConnectors, connectorsSentence, labelsOf, visibleConnectors, type AgentConnector } from './catalog.js';
import type { McpDeps } from './deps.js';
import { connectorListing, groupsOf, type ConnectorListing } from './listing.js';
import { functionsText, searchTools, selectedNames, type SearchTool } from './search.js';
import { textBlock, type ToolResult } from './tool-result.js';

interface Listing extends ConnectorListing {
  connector: AgentConnector;
}

const EMPTY_SCHEMA = { type: 'object', properties: {} };

function wanted(connectors: AgentConnector[], query: string): AgentConnector[] {
  const names = selectedNames(query);
  if (names === null) return connectors;
  const keys = new Set(names.map((name) => splitMcpTool(name)?.connector ?? name.toLowerCase().split('.')[0] ?? ''));
  return connectors.filter((connector) => keys.has(connector.key));
}

const listingOf = async (deps: McpDeps, identity: DeliveryIdentity, connector: AgentConnector): Promise<Listing> => ({ connector, ...(await connectorListing(deps, identity, connector)) });

function searchable(listing: Listing): SearchTool[] {
  const groups = groupsOf(listing.tools);
  return listing.tools
    .filter((tool) => listing.connector.access.decide(tool.name, groups) !== 'deny')
    .map((tool) => ({ name: `${listing.connector.key}.${tool.name}`, title: tool.title, description: tool.description === '' ? tool.title : tool.description, parameters: tool.inputSchema ?? EMPTY_SCHEMA }))
    .filter((tool) => splitMcpTool(tool.name) !== null);
}

const BROADER = ' Try a broader query with fewer words, or "select:<connector>.<tool>" with an exact name.';

function noMatch(query: string, connectors: AgentConnector[], listings: Listing[]): string {
  const failures = listings.filter((listing) => listing.status !== 'ok' && listing.error !== undefined).map((listing) => `${listing.connector.key}: ${listing.error ?? ''}`);
  const hint = visibleConnectors(connectors).length === 0 ? '' : BROADER;
  return [`No tool matched "${query}". ${connectorsSentence(connectors)}${hint}`, ...failures].join('\n');
}

const callFooter = (found: SearchTool[]): string => `Call these with tool_call: {"calls":[{"tool":"${found[0]?.name ?? '<name>'}","arguments":{…}}]}`;

function statusOf(listings: Listing[], key: string): Record<string, unknown> {
  const listing = listings.find((candidate) => candidate.connector.key === key);
  if (listing === undefined) return {};
  return { status: listing.status, ...(listing.error === undefined ? {} : { error: listing.error }) };
}

function structured(connectors: AgentConnector[], listings: Listing[], found: SearchTool[]): Record<string, unknown> {
  return {
    connectors: labelsOf(connectors).map((label) => ({ ...label, ...statusOf(listings, label.key) })),
    tools: found.map((tool) => ({ name: tool.name, title: tool.title, connector: splitMcpTool(tool.name)?.connector ?? '' })),
  };
}

export async function findTools(deps: McpDeps, identity: DeliveryIdentity, request: McpFindRequest): Promise<ToolResult> {
  const connectors = visibleConnectors(await agentConnectors(deps, identity));
  await deps.toolLists.preload(connectors.map((connector) => connector.id));
  const listings = await Promise.all(wanted(connectors, request.query).map((connector) => listingOf(deps, identity, connector)));
  const found = searchTools(listings.flatMap(searchable), request.query, request.max_results);
  const text = found.length === 0 ? noMatch(request.query, connectors, listings) : `${functionsText(found)}\n${callFooter(found)}`;
  return { content: [textBlock(text)], structuredContent: structured(connectors, listings, found) };
}
