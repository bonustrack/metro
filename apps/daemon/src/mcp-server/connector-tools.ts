import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';
import { TOOL_CALL, TOOL_SEARCH } from '@metro-labs/http/mcp-server-protocol';
import { mcpServerTools, type McpServerTool } from '@metro-labs/http/mcp-server-tools';
import { askServer, type ServerAnswer, type ServerDeps } from './rpc.js';

export const CONNECTOR_TOOLS: ReadonlySet<string> = new Set([TOOL_SEARCH, TOOL_CALL]);

export const CALL_TIMEOUT_MS = 120_000;
const LIST_TIMEOUT_MS = 15_000;
const REFRESH_MS = 5 * 60_000;

export const NOT_SET_UP = 'Connectors are not set up on this agent: enroll it in its organization on the Server page of metro.box, then try again.';
export const UNAVAILABLE = 'mcp.metro.box is unavailable, try again.';

export interface ConnectorResult {
  [key: string]: unknown;
  content: unknown[];
  isError?: boolean;
}

const FALLBACK = mcpServerTools(null);
let current: McpServerTool[] = FALLBACK;
let version = 0;
const listeners = new Set<() => void>();

export const connectorTools = (): McpServerTool[] => current;

export const connectorToolsVersion = (): number => version;

export function onConnectorToolsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function toolOf(raw: unknown, fallback: McpServerTool): McpServerTool | null {
  if (!isRecord(raw) || typeof raw.description !== 'string' || !isRecord(raw.inputSchema)) return null;
  return {
    name: fallback.name,
    title: typeof raw.title === 'string' ? raw.title : fallback.title,
    description: raw.description,
    inputSchema: raw.inputSchema,
    annotations: isRecord(raw.annotations) ? raw.annotations : fallback.annotations,
  };
}

function servedTools(result: unknown): McpServerTool[] | null {
  const tools: unknown[] = isRecord(result) && Array.isArray(result.tools) ? result.tools : [];
  const picked = FALLBACK.map((fallback) => toolOf(tools.find((tool) => isRecord(tool) && tool.name === fallback.name), fallback));
  return picked.every((tool): tool is McpServerTool => tool !== null) ? picked : null;
}

function changed(): void {
  for (const listener of listeners)
    try {
      listener();
    } catch (err) {
      log.warn({ err: errMsg(err) }, 'mcp-server: a tool list listener failed');
    }
}

export async function refreshConnectorTools(deps: ServerDeps = {}): Promise<boolean> {
  const answer = await askServer('tools/list', {}, LIST_TIMEOUT_MS, deps);
  const tools = answer.ok ? servedTools(answer.result) : null;
  if (tools === null) {
    if (!answer.ok && answer.reason !== 'unset') log.debug({ reason: answer.reason }, 'mcp-server: the connector tool list could not be read');
    return false;
  }
  if (JSON.stringify(tools) === JSON.stringify(current)) return false;
  current = tools;
  version += 1;
  log.info({ version }, 'mcp-server: the connector tools changed, the session is told');
  changed();
  return true;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function watchConnectorTools(everyMs = REFRESH_MS): () => void {
  const tick = (): void => {
    refreshConnectorTools().catch((err: unknown) => {
      log.warn({ err: errMsg(err) }, 'mcp-server: the connector tool refresh failed');
    });
  };
  if (timer === null) {
    tick();
    timer = setInterval(tick, everyMs);
    timer.unref();
  }
  return () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
}

const errorResult = (text: string): ConnectorResult => ({ content: [{ type: 'text', text }], isError: true });

function resultOf(name: string, answer: ServerAnswer): ConnectorResult {
  if (answer.ok) {
    if (isRecord(answer.result) && Array.isArray(answer.result.content)) return answer.result as ConnectorResult;
    log.warn({ tool: name }, 'mcp-server: mcp.metro.box answered a tool call without content');
    return errorResult(UNAVAILABLE);
  }
  if (answer.reason === 'unset') return errorResult(NOT_SET_UP);
  if (answer.reason === 'refused') return errorResult(`mcp.metro.box refused the call: ${answer.message}`);
  log.warn({ tool: name, detail: answer.detail }, 'mcp-server: a connector tool call did not reach mcp.metro.box');
  return errorResult(UNAVAILABLE);
}

export async function callConnectorTool(name: string, args: Record<string, unknown>, deps: ServerDeps = {}): Promise<ConnectorResult> {
  return resultOf(name, await askServer('tools/call', { name, arguments: args }, CALL_TIMEOUT_MS, deps));
}
