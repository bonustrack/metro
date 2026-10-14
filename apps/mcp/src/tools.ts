import { MCP_CALLS_MAX } from '@metro-labs/http/mcp-server-protocol';
import { mcpServerTools, type McpServerTool } from '@metro-labs/http/mcp-server-tools';

export { TOOL_CALL, TOOL_SEARCH } from '@metro-labs/http/mcp-server-protocol';

export const MCP_INSTRUCTIONS = [
  'This server runs the tools of the connectors the owner gave this agent on metro.box: third-party tools like Notion, n8n or Gmail, reached only through tool_search then tool_call, from a worker.',
  'Their tools are not listed here: call tool_search first, with keywords or with select:<connector>.<tool>, to get each tool\'s name, description and JSON schema.',
  `Then run them with tool_call, naming each tool exactly as tool_search returned it, with arguments that match its schema. Up to ${String(MCP_CALLS_MAX)} independent calls run in parallel in one tool_call.`,
  'Tools the owner blocked never appear. When a call answers needs_approval, the owner was asked in chat and on metro.box: wait until you are told it was approved, then repeat the same call with the same arguments and the approval id. An approval works once.',
].join(' ');

export const toolList = (keys: string[]): McpServerTool[] => mcpServerTools(keys);
