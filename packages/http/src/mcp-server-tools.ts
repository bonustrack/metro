import { MCP_CALLS_MAX, MCP_FIND_DEFAULT, MCP_FIND_MAX, TOOL_CALL, TOOL_CALL_EXAMPLE, TOOL_SEARCH } from './mcp-server-protocol.js';

export interface McpServerTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
}

const searchSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'What to look for: "select:<connector>.<tool>" (comma separated) loads exact tools, keywords rank tools, "+word" requires that word in the tool name.',
    },
    max_results: { type: 'number', description: `Maximum number of results to return (default: ${String(MCP_FIND_DEFAULT)}, at most ${String(MCP_FIND_MAX)})`, default: MCP_FIND_DEFAULT },
  },
  required: ['query'],
  additionalProperties: false,
};

const callSchema = {
  type: 'object',
  properties: {
    calls: {
      type: 'array',
      minItems: 1,
      maxItems: MCP_CALLS_MAX,
      description: `1 to ${String(MCP_CALLS_MAX)} independent calls. They run in parallel and are answered in order.`,
      items: {
        type: 'object',
        properties: {
          tool: { type: 'string', description: 'The tool name exactly as tool_search returned it: <connector>.<tool>.' },
          arguments: { type: 'object', description: 'The tool\'s arguments, matching the parameters tool_search returned.', additionalProperties: true },
          approval: { type: 'string', pattern: '^[a-km-z]{5}$', description: 'The 5-letter approval id, only when repeating a call the owner approved.' },
        },
        required: ['tool'],
        additionalProperties: false,
      },
    },
  },
  required: ['calls'],
  additionalProperties: false,
};

export interface ConnectorLabel {
  key: string;
  name: string;
}

const LABELS_MAX = 900;

export function connectorLabel(connector: ConnectorLabel): string {
  const name = connector.name.replace(/\s+/g, ' ').trim();
  return name === '' || name.toLowerCase() === connector.key ? connector.key : `${connector.key} (${name})`;
}

function connectorsLine(connectors: ConnectorLabel[] | null): string {
  if (connectors === null) return 'The connectors of this agent are named here once Metro reaches mcp.metro.box.';
  if (connectors.length === 0) return 'This agent has no connectors it may use yet.';
  const labels = connectors.map(connectorLabel).join(', ');
  return `This agent's connectors: ${labels.length > LABELS_MAX ? connectors.map((connector) => connector.key).join(', ') : labels}.`;
}

export const toolSearchDescription = (connectors: ConnectorLabel[] | null): string =>
  [
    'Search the tools of every connector assigned to this agent: third-party services such as Notion, n8n, Linear or Gmail, run by mcp.metro.box. Same design as Claude Code\'s ToolSearch, for connectors.',
    connectorsLine(connectors),
    'Three query forms, one example each:',
    '- "select:notion.search" loads exact tools by name (comma separated for several).',
    '- "notion create page" ranks tools by the words in their name and description.',
    '- "+linear issue" requires "linear" in the tool name and ranks by the other words.',
    'Results are full definitions (name, description and the JSON schema of the arguments) in a <functions> block. Each name is <connector>.<tool>: pass it exactly as "tool" to tool_call. Tools the owner blocked are never returned.',
  ].join('\n');

export type ApprovalPlace = 'session' | 'page' | 'owner';

const NEEDS_APPROVAL: Record<ApprovalPlace, string> = {
  session: '- needs_approval: the owner was asked in chat and on metro.box. Tell the person what is waiting, wait for the channel message "Approved: <tool> (<id>)", then call again with the same tool and arguments plus "approval": "<id>". An approval works once.',
  page: '- needs_approval: the owner must approve it on this agent\'s page on metro.box. Tell the person what is waiting and ask them to approve it there, then call again with the same tool and arguments plus "approval": "<id>". An approval works once, within 10 minutes of the answer.',
  owner: '- needs_approval: the agent\'s owner was asked in chat and on its page on metro.box. Tell the person what is waiting; once it is approved, call again with the same tool and arguments plus "approval": "<id>". An approval works once, within 10 minutes of the answer.',
};

const toolCallDescription = (place: ApprovalPlace): string =>
  [
    'Run connector tools that tool_search found. Always find a tool with tool_search first: its exact name and argument schema come from there.',
    `Shape: ${TOOL_CALL_EXAMPLE}`,
    `Up to ${String(MCP_CALLS_MAX)} independent calls run in parallel in one tool_call and are answered in order. Each result starts with "[n] <connector>.<tool>", then the tool's own content, or one line saying why it did not run:`,
    '- not_found: no such connector or tool here. Run tool_search, then use a name it returned.',
    NEEDS_APPROVAL[place],
    '- denied or blocked: the owner refused or blocked this call. Do not retry it.',
    '- signin: the connector must be signed in again. Tell the owner to do it on the organization\'s Connectors page on metro.box.',
    '- unavailable: the connector or Metro could not be reached. Try again later.',
    '- vendor_error: the connector answered with its own error, shown as it came.',
  ].join('\n');

export function mcpServerTools(connectors: ConnectorLabel[] | null, place: ApprovalPlace = 'session'): McpServerTool[] {
  return [
    {
      name: TOOL_SEARCH,
      title: 'Search connector tools',
      description: toolSearchDescription(connectors),
      inputSchema: searchSchema,
      annotations: { title: 'Search connector tools', readOnlyHint: true, openWorldHint: false },
    },
    {
      name: TOOL_CALL,
      title: 'Call connector tools',
      description: toolCallDescription(place),
      inputSchema: callSchema,
      annotations: { title: 'Call connector tools', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
  ];
}
