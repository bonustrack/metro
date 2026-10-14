import { splitMcpTool, type McpFindRequest } from '@metro-labs/http/mcp-server-protocol';
import type { RemoteTool } from '@metro-labs/http/connector-tools';
import type { AgentKeyRow } from '@metro-labs/connectors/db/agent-keys';
import { agentConnectors, connectorsSentence, type AgentConnector } from './catalog.js';
import type { McpDeps } from './deps.js';
import { connectorTools, failureOf, groupsOf } from './listing.js';
import { functionsText, searchTools, selectedNames, type SearchTool } from './search.js';
import { textBlock, type ToolResult } from './tool-result.js';

interface Listing {
  connector: AgentConnector;
  tools: RemoteTool[];
  failure?: string;
}

const EMPTY_SCHEMA = { type: 'object', properties: {} };

function wanted(connectors: AgentConnector[], query: string): AgentConnector[] {
  const names = selectedNames(query);
  if (names === null) return connectors;
  const keys = new Set(names.map((name) => splitMcpTool(name)?.connector ?? name.toLowerCase().split('.')[0] ?? ''));
  return connectors.filter((connector) => keys.has(connector.key));
}

async function listingOf(deps: McpDeps, identity: AgentKeyRow, connector: AgentConnector): Promise<Listing> {
  try {
    return { connector, tools: await connectorTools(deps, identity, connector) };
  } catch (err) {
    return { connector, tools: [], failure: failureOf(err, connector.name).message };
  }
}

function searchable(listing: Listing): SearchTool[] {
  const groups = groupsOf(listing.tools);
  return listing.tools
    .filter((tool) => listing.connector.access.decide(tool.name, groups) !== 'deny')
    .map((tool) => ({ name: `${listing.connector.key}.${tool.name}`, title: tool.title, description: tool.description === '' ? tool.title : tool.description, parameters: tool.inputSchema ?? EMPTY_SCHEMA }))
    .filter((tool) => splitMcpTool(tool.name) !== null);
}

function noMatch(query: string, connectors: AgentConnector[], listings: Listing[]): string {
  const failures = listings.filter((listing) => listing.failure !== undefined).map((listing) => `${listing.connector.key}: ${listing.failure ?? ''}`);
  return [`No tool matched "${query}". ${connectorsSentence(connectors)}`, ...failures].join('\n');
}

export async function findTools(deps: McpDeps, identity: AgentKeyRow, request: McpFindRequest): Promise<ToolResult> {
  const connectors = (await agentConnectors(deps, identity)).filter((connector) => !connector.access.blocked);
  const listings = await Promise.all(wanted(connectors, request.query).map((connector) => listingOf(deps, identity, connector)));
  const found = searchTools(listings.flatMap(searchable), request.query, request.max_results);
  const text = found.length === 0 ? noMatch(request.query, connectors, listings) : functionsText(found);
  return { content: [textBlock(text)] };
}
