import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolRequest, type CallToolResult, type ListToolsResult } from '@modelcontextprotocol/sdk/types.js';

export const METRO_SERVER = 'metro';

export interface ToolSource {
  readonly instructions: string | undefined;
  listTools(): Promise<ListToolsResult>;
  callTool(params: CallToolRequest['params'], signal: AbortSignal): Promise<CallToolResult>;
}

export interface MetroTools {
  config: McpSdkServerConfigWithInstance;
  readOnly(tool: string): boolean;
  changed(): void;
}

export function metroTools(source: ToolSource): MetroTools {
  const instructions = source.instructions;
  const reads = new Set<string>();
  const server = new McpServer(
    { name: METRO_SERVER, version: '0.1.0' },
    { capabilities: { tools: { listChanged: true } }, ...(instructions === undefined ? {} : { instructions }) },
  );
  server.server.setRequestHandler(ListToolsRequestSchema, async () => {
    const listed = await source.listTools();
    reads.clear();
    for (const tool of listed.tools) if (tool.annotations?.readOnlyHint === true) reads.add(tool.name);
    return listed;
  });
  server.server.setRequestHandler(CallToolRequestSchema, (request, extra) => source.callTool(request.params, extra.signal));
  return {
    config: { type: 'sdk', name: METRO_SERVER, instance: server },
    readOnly: (tool) => reads.has(tool),
    changed: () => {
      server.sendToolListChanged();
    },
  };
}
