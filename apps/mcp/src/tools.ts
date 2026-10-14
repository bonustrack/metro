import { MCP_CALLS_MAX, MCP_FIND_DEFAULT, MCP_FIND_MAX } from '@metro-labs/http/mcp-server-protocol';

export const FIND_TOOLS = 'find_tools';
export const CALL_TOOL = 'call_tool';

export const MCP_INSTRUCTIONS = [
  'This server runs the tools of the connectors the owner gave this agent on metro.box (Notion, Linear, n8n and the like).',
  'Their tools are not listed here: call find_tools first, with keywords or with select:<connector>.<tool>, to get each tool\'s name, description and JSON schema.',
  `Then run them with call_tool, naming each tool exactly as find_tools returned it, with arguments that match its schema. Up to ${String(MCP_CALLS_MAX)} independent calls run in parallel in one call_tool.`,
  'Tools the owner blocked never appear. When a call answers needs_approval, the owner was asked in chat and on metro.box: wait until you are told it was approved, then repeat the same call with the same arguments and the approval id. An approval works once.',
].join(' ');

const findSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Query to find connector tools. Use "select:<connector>.<tool>" (comma separated) for direct selection, or keywords to search; "+word" requires that word in the tool name.',
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
          tool: { type: 'string', description: 'The tool name exactly as find_tools returned it: <connector>.<tool>.' },
          arguments: { type: 'object', description: 'The tool\'s arguments, matching the parameters find_tools returned.', additionalProperties: true },
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

function findDescription(keys: string[]): string {
  const connectors = keys.length === 0 ? 'This agent has no connectors it may use yet.' : `This agent's connectors: ${keys.join(', ')}.`;
  return `Search the tools of this agent's connectors and load their definitions. ${connectors} "select:notion.search,linear.create_issue" loads those exact tools; keywords ("notion page update") rank tools by name and description; "+slack send" requires "slack" in the tool name. Returns the matching tools in a <functions> block; run them with call_tool.`;
}

export function toolList(keys: string[]): Record<string, unknown>[] {
  return [
    { name: FIND_TOOLS, title: 'Find connector tools', description: findDescription(keys), inputSchema: findSchema, annotations: { title: 'Find connector tools', readOnlyHint: true, openWorldHint: false } },
    {
      name: CALL_TOOL,
      title: 'Call connector tools',
      description: 'Run up to 10 connector tools found with find_tools, in parallel. Each result starts with "[n] <connector>.<tool>", then the tool\'s own content, or one line saying why it did not run (blocked, needs_approval, denied, not_found, signin, unavailable, vendor_error).',
      inputSchema: callSchema,
      annotations: { title: 'Call connector tools', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
  ];
}
