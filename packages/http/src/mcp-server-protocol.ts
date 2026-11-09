import { ID_RE } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { emailReceivedOf, type EmailReceived } from './mcp-events.js';

export const MCP_PATHS = { token: '/v1/token', approvals: '/v1/approvals', answer: '/v1/approvals/answer', mailTaken: '/v1/mail/taken' } as const;
export const MCP_EVENTS_PATH = '/v1/events/';
export const MAIL_TAKEN_MAX = 50;
export const MCP_FIND_DEFAULT = 5;
export const MCP_FIND_MAX = 20;
export const MCP_CALLS_MAX = 10;
const MCP_QUERY_MAX = 500;
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

type McpApprovalOrigin = 'box' | 'key';

const KEY_LABEL_MAX = 64;

export interface McpApproval {
  id: string;
  connector: string;
  tool: string;
  preview: string;
  requestedAt: number;
  origin?: McpApprovalOrigin;
  keyLabel?: string;
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

function originOf(raw: Record<string, unknown>): Pick<McpApproval, 'origin' | 'keyLabel'> {
  if (raw.origin === 'box') return { origin: 'box' };
  if (raw.origin !== 'key') return {};
  const label = typeof raw.keyLabel === 'string' ? raw.keyLabel.replace(/\p{Cc}/gu, '').trim() : '';
  return label === '' || label.length > KEY_LABEL_MAX ? { origin: 'key' } : { origin: 'key', keyLabel: label };
}

function approvalOf(raw: unknown): McpApproval | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !MCP_APPROVAL_ID_RE.test(raw.id) || typeof raw.connector !== 'string' || typeof raw.tool !== 'string' || typeof raw.preview !== 'string' || typeof raw.requestedAt !== 'number') return null;
  return { id: raw.id, connector: raw.connector, tool: raw.tool, preview: raw.preview, requestedAt: raw.requestedAt, ...originOf(raw) };
}

export function mcpApprovalsOf(raw: unknown): McpApproval[] {
  if (!isRecord(raw) || !Array.isArray(raw.approvals)) throw new Error('Mcp sent an unreadable approval list.');
  return raw.approvals.map(approvalOf).filter((row): row is McpApproval => row !== null);
}

export function mcpAnswerOf(raw: unknown): { id: string; decision: McpDecision } {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !MCP_APPROVAL_ID_RE.test(raw.id) || (raw.decision !== 'allow' && raw.decision !== 'deny')) throw new Error('An answer needs the approval id and allow or deny.');
  return { id: raw.id, decision: raw.decision };
}

export type MailOutcome = 'delivered' | 'paused';

export interface McpMail extends EmailReceived {
  id: string;
  connector: string;
  key: string;
  name: string;
}

export interface MailTaken {
  id: string;
  outcome: MailOutcome;
}

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const CONNECTOR_NAME_MAX = 256;

const idOf = (value: unknown): string | null => (typeof value === 'string' && ID_RE.test(value) ? value : null);

function mailOf(raw: unknown): McpMail | null {
  if (!isRecord(raw)) return null;
  const id = idOf(raw.id);
  const connector = idOf(raw.connector);
  const key = typeof raw.key === 'string' && KEY_RE.test(raw.key) ? raw.key : null;
  const mail = emailReceivedOf(raw);
  if (id === null || connector === null || key === null || mail === null) return null;
  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim().slice(0, CONNECTOR_NAME_MAX) : key;
  return { ...mail, id, connector, key, name };
}

export function mcpMailOf(raw: unknown): McpMail[] {
  if (!isRecord(raw) || !Array.isArray(raw.mail)) return [];
  return raw.mail.map(mailOf).filter((row): row is McpMail => row !== null);
}

export function mailTakenOf(raw: unknown): MailTaken[] {
  const taken = isRecord(raw) ? raw.taken : undefined;
  if (!Array.isArray(taken) || taken.length === 0 || taken.length > MAIL_TAKEN_MAX) throw new Error(`taken must list 1 to ${String(MAIL_TAKEN_MAX)} mails.`);
  return taken.map((row) => {
    if (!isRecord(row) || typeof row.id !== 'string' || !ID_RE.test(row.id) || (row.outcome !== 'delivered' && row.outcome !== 'paused')) throw new Error('Each taken mail needs its id and delivered or paused.');
    return { id: row.id, outcome: row.outcome };
  });
}
