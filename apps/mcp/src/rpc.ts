import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';
import { METRO_VERSION } from '@metro-labs/core/version';
import { mcpCallsOf, mcpFindRequestOf } from '@metro-labs/http/mcp-server-protocol';
import type { DeliveryIdentity } from '@metro-labs/connectors/db/connector-delivery';
import { callTools } from './call.js';
import { agentConnectors, labelsOf } from './catalog.js';
import type { McpDeps } from './deps.js';
import { findTools } from './find.js';
import { errorResult, type ToolResult } from './tool-result.js';
import { mcpServerTools, type ApprovalPlace } from '@metro-labs/http/mcp-server-tools';
import { approvalPlace, INSTRUCTIONS, TOOL_CALL, TOOL_SEARCH } from './tools.js';

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

type Reply = Record<string, unknown>;
type RequestId = string | number | null;

interface RpcContext {
  deps: McpDeps;
  identity: DeliveryIdentity;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const failure = (id: RequestId, code: number, message: string): Reply => ({ jsonrpc: '2.0', id, error: { code, message } });

function initialize(params: Record<string, unknown>, place: ApprovalPlace): Reply {
  const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
  return {
    protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
    capabilities: { tools: {} },
    serverInfo: { name: 'metro', version: METRO_VERSION },
    instructions: INSTRUCTIONS[place],
  };
}

async function runTool(ctx: RpcContext, name: string, args: unknown): Promise<ToolResult> {
  if (name === TOOL_SEARCH) {
    let request;
    try { request = mcpFindRequestOf(args); } catch (err) { return errorResult(errMsg(err)); }
    return findTools(ctx.deps, ctx.identity, request);
  }
  let calls;
  try { calls = mcpCallsOf(args); } catch (err) { return errorResult(errMsg(err)); }
  return callTools(ctx.deps, ctx.identity, calls);
}

async function toolCall(ctx: RpcContext, params: Record<string, unknown>): Promise<ToolResult> {
  const name = typeof params.name === 'string' ? params.name : '';
  if (name !== TOOL_SEARCH && name !== TOOL_CALL) throw new RpcError(-32602, `Unknown tool: ${name.slice(0, 64)}. This server has tool_search and tool_call.`);
  try {
    return await runTool(ctx, name, params.arguments ?? {});
  } catch (err) {
    log.warn({ agent: ctx.identity.agent, tool: name, err: errMsg(err) }, 'mcp: a tool failed');
    return errorResult('Metro could not run this right now. Try again in a few minutes.');
  }
}

async function result(ctx: RpcContext, method: string, params: Record<string, unknown>): Promise<unknown> {
  const place = approvalPlace(ctx.identity);
  if (method === 'initialize') return initialize(params, place);
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools: mcpServerTools(labelsOf(await agentConnectors(ctx.deps, ctx.identity)), place) };
  if (method === 'tools/call') return toolCall(ctx, params);
  throw new RpcError(-32601, `Method not found: ${method.slice(0, 64)}`);
}

const idOf = (message: Record<string, unknown>): RequestId | undefined => {
  const id = message.id;
  return typeof id === 'string' || typeof id === 'number' || id === null ? id : undefined;
};

export async function answerMessage(ctx: RpcContext, message: unknown): Promise<Reply | null> {
  if (!isRecord(message) || message.jsonrpc !== '2.0') return failure(null, -32600, 'Invalid request');
  if (typeof message.method !== 'string') return null;
  if (!Object.hasOwn(message, 'id')) return null;
  const id = idOf(message);
  if (id === undefined || id === null) return failure(null, -32600, 'Invalid request id');
  const params = isRecord(message.params) ? message.params : {};
  try {
    return { jsonrpc: '2.0', id, result: await result(ctx, message.method, params) };
  } catch (err) {
    if (err instanceof RpcError) return failure(id, err.code, err.message);
    log.warn({ agent: ctx.identity.agent, method: message.method, err: errMsg(err) }, 'mcp: a request failed');
    return failure(id, -32603, 'Internal error');
  }
}
