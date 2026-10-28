import { connectorIcons } from '@metro-labs/core/brands';
import { isRecord } from '@metro-labs/core/is-record';
import type { McpServerTool } from '@metro-labs/http/mcp-server-tools';
import type { DeliveryIdentity } from '@metro-labs/connectors/db/connector-delivery';
import { agentConnectors, visibleConnectors, type AgentConnector } from './catalog.js';
import type { McpDeps } from './deps.js';
import { connectorListing, groupsOf, type ConnectorListing } from './listing.js';
import { textBlock, type ToolResult } from './tool-result.js';

export const LIST_CONNECTORS = 'list_connectors';
const KEY_MAX = 64;

export const listConnectorsTool: McpServerTool = {
  name: LIST_CONNECTORS,
  title: 'List connectors',
  description: [
    'List the connectors this agent may use, each with its state (ok, listing, signin, unavailable), its number of tools and its icon. It answers from Metro\'s cache and never waits on a connector.',
    'Pass "connector" (a key) for that connector\'s tools, or "tools": true for the tools of every connector: name, title, description, whether it only reads, and whether it needs approval. Schemas come from tool_search.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      connector: { type: 'string', description: 'A connector key: answer only this connector, with its tools.' },
      tools: { type: 'boolean', description: 'Include the tools of every connector.' },
    },
    additionalProperties: false,
  },
  annotations: { title: 'List connectors', readOnlyHint: true, openWorldHint: false },
};

interface ListRequest {
  connector?: string;
  tools: boolean;
}

export function listRequestOf(raw: unknown): ListRequest {
  const { connector, tools } = isRecord(raw) ? raw : {};
  if (connector !== undefined && (typeof connector !== 'string' || connector === '' || connector.length > KEY_MAX)) throw new Error(`connector must be a connector key of 1 to ${String(KEY_MAX)} characters.`);
  if (tools !== undefined && typeof tools !== 'boolean') throw new Error('tools must be true or false.');
  return connector === undefined ? { tools: tools === true } : { connector, tools: true };
}

function toolsOf(connector: AgentConnector, listing: ConnectorListing): Record<string, unknown>[] {
  const groups = groupsOf(listing.tools);
  return listing.tools.flatMap((tool) => {
    const access = connector.access.decide(tool.name, groups);
    if (access === 'deny') return [];
    return [{ name: `${connector.key}.${tool.name}`, title: tool.title, description: tool.description, readOnly: tool.readOnly, ...(tool.destructive === true ? { destructive: true } : {}), ...(access === 'ask' ? { ask: true } : {}) }];
  });
}

function entryOf(connector: AgentConnector, listing: ConnectorListing, withTools: boolean): Record<string, unknown> {
  const tools = toolsOf(connector, listing);
  const line = `${connector.key} (${connector.name}): ${listing.status}, ${String(tools.length)} tools${listing.error === undefined ? '' : `. ${listing.error}`}`;
  return {
    line,
    entry: {
      key: connector.key,
      name: connector.name,
      status: listing.status,
      ...(listing.error === undefined ? {} : { error: listing.error }),
      ...(listing.listedAt === undefined ? {} : { listedAt: listing.listedAt }),
      toolCount: tools.length,
      icons: connectorIcons(connector.assigned.connector.url),
      ...(withTools ? { tools } : {}),
    },
  };
}

export async function listConnectors(deps: McpDeps, identity: DeliveryIdentity, request: ListRequest): Promise<ToolResult> {
  const connectors = visibleConnectors(await agentConnectors(deps, identity)).filter((connector) => request.connector === undefined || connector.key === request.connector);
  if (request.connector !== undefined && connectors.length === 0) return { content: [textBlock(`No connector "${request.connector}" is assigned to this agent.`)], isError: true };
  await deps.toolLists.preload(connectors.map((connector) => connector.id));
  const answers = await Promise.all(connectors.map(async (connector) => entryOf(connector, await connectorListing(deps, identity, connector, { waitMs: 0 }), request.tools)));
  const text = answers.length === 0 ? 'This agent has no connectors it may use.' : answers.map((answer) => answer.line).join('\n');
  return { content: [textBlock(text)], structuredContent: { connectors: answers.map((answer) => answer.entry) } };
}
