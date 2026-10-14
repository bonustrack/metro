import { isRecord } from '@metro-labs/core/is-record';

export const MCP_PATHS = { token: '/v1/token', approvals: '/v1/approvals', answer: '/v1/approvals/answer' } as const;
export const MCP_FIND_DEFAULT = 5;
export const MCP_FIND_MAX = 20;
export const MCP_CALLS_MAX = 10;
export const MCP_QUERY_MAX = 500;
export const MCP_APPROVAL_WAIT_MS = 25_000;
export const MCP_APPROVAL_ID_RE = /^[a-km-z]{5}$/;
export const TOOL_SEARCH = 'tool_search';
export const TOOL_CALL = 'tool_call';
export const TOOL_CALL_EXAMPLE = '{"calls":[{"tool":"notion.search","arguments":{"query":"roadmap"}}]}';

const EXPECTED = ` Expected: ${TOOL_CALL_EXAMPLE}, with names as tool_search returns them.`;
export const MCP_TOKEN_RE = /^mcp_[A-Za-z0-9_-]{43}$/;

export type McpErrorCode = 'blocked' | 'needs_approval' | 'denied' | 'not_found' | 'signin' | 'unavailable' | 'vendor_error' | 'invalid';

export interface McpFindRequest {
  query: string;
  max_results: number;
}

export interface McpCall {
  tool: string;
  arguments: Record<string, unknown>;
  approval?: string;
}

export interface McpApproval {
  id: string;
  connector: string;
  tool: string;
  preview: string;
  requestedAt: number;
}

export type McpDecision = 'allow' | 'deny';

const TOOL_RE = /^([a-z0-9][a-z0-9-]{0,62})\.([A-Za-z0-9_][A-Za-z0-9_.:/-]{0,127})$/;

export function splitMcpTool(name: string): { connector: string; tool: string } | null {
  const match = TOOL_RE.exec(name);
  return match === null ? null : { connector: match[1] ?? '', tool: match[2] ?? '' };
}

export function mcpFindRequestOf(raw: unknown): McpFindRequest {
  if (!isRecord(raw) || typeof raw.query !== 'string' || raw.query.trim() === '' || raw.query.length > MCP_QUERY_MAX) throw new Error('tool_search needs a query of 1 to 500 characters.');
  const wanted = raw.max_results ?? MCP_FIND_DEFAULT;
  if (typeof wanted !== 'number' || !Number.isInteger(wanted) || wanted < 1) throw new Error('max_results must be a whole number from 1.');
  return { query: raw.query.trim(), max_results: Math.min(wanted, MCP_FIND_MAX) };
}

function callOf(raw: unknown): McpCall {
  if (!isRecord(raw) || typeof raw.tool !== 'string' || splitMcpTool(raw.tool) === null) throw new Error(`Each call needs a tool named <connector>.<tool>, as tool_search returns it.${EXPECTED}`);
  const args = raw.arguments ?? {};
  if (!isRecord(args)) throw new Error(`The arguments of ${raw.tool} must be an object.${EXPECTED}`);
  if (raw.approval !== undefined && (typeof raw.approval !== 'string' || !MCP_APPROVAL_ID_RE.test(raw.approval))) throw new Error('approval must be the 5-letter id the approval request gave.');
  return { tool: raw.tool, arguments: args, ...(typeof raw.approval === 'string' ? { approval: raw.approval } : {}) };
}

export function mcpCallsOf(raw: unknown): McpCall[] {
  const calls = isRecord(raw) ? raw.calls : undefined;
  if (!Array.isArray(calls) || calls.length === 0 || calls.length > MCP_CALLS_MAX) throw new Error(`tool_call needs 1 to ${String(MCP_CALLS_MAX)} calls in "calls".${EXPECTED}`);
  return calls.map(callOf);
}

export function mcpTokenHashOf(raw: unknown): string {
  if (!isRecord(raw) || typeof raw.tokenHash !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw.tokenHash)) throw new Error('tokenHash must be the base64url SHA-256 of the MCP token.');
  return raw.tokenHash;
}

function approvalOf(raw: unknown): McpApproval | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !MCP_APPROVAL_ID_RE.test(raw.id) || typeof raw.connector !== 'string' || typeof raw.tool !== 'string' || typeof raw.preview !== 'string' || typeof raw.requestedAt !== 'number') return null;
  return { id: raw.id, connector: raw.connector, tool: raw.tool, preview: raw.preview, requestedAt: raw.requestedAt };
}

export function mcpApprovalsOf(raw: unknown): McpApproval[] {
  if (!isRecord(raw) || !Array.isArray(raw.approvals)) throw new Error('Mcp sent an unreadable approval list.');
  return raw.approvals.map(approvalOf).filter((row): row is McpApproval => row !== null);
}

export function mcpAnswerOf(raw: unknown): { id: string; decision: McpDecision } {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !MCP_APPROVAL_ID_RE.test(raw.id) || (raw.decision !== 'allow' && raw.decision !== 'deny')) throw new Error('An answer needs the approval id and allow or deny.');
  return { id: raw.id, decision: raw.decision };
}
