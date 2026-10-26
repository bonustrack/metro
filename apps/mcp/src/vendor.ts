import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { authHeaders, INITIALIZE, mcpPost } from '@metro-labs/http/connector-mcp';
import { ConnectorUnauthorized, refused } from '@metro-labs/http/connector-url';
import type { VendorTarget } from './credential.js';
import { CallError } from './errors.js';

const VENDOR_INIT_MS = 15_000;
export const VENDOR_CALL_MS = 60_000;
const CALL_ID = 2;
const MESSAGE_MAX = 500;

interface VendorAnswer {
  content: Record<string, unknown>[];
  isError: boolean;
  structuredContent?: unknown;
}

type Session = Map<string, string>;

interface RpcBody {
  jsonrpc: string;
  id: number;
  method: string;
  params?: unknown;
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function messagesOf(text: string, contentType: string): unknown[] {
  if (!contentType.includes('text/event-stream')) {
    const value = parsed(text);
    return Array.isArray(value) ? value : [value];
  }
  return text
    .replace(/\r\n/g, '\n')
    .split('\n\n')
    .map((event) => event.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n'))
    .filter((data) => data !== '')
    .map(parsed);
}

function checkStatus(res: Response, target: VendorTarget): void {
  if (res.status === 401 || res.status === 403) throw new ConnectorUnauthorized(`${target.url.hostname} rejected the credential`, 400);
  if (res.status >= 300 && res.status < 400) throw refused(`${target.url.hostname} redirected the call, which Metro does not follow`);
  if (!res.ok) throw refused(`${target.url.hostname} answered ${String(res.status)}`);
}

async function post(target: VendorTarget, session: Session, body: unknown, timeoutMs: number, fetch: FetchLike): Promise<{ res: Response; text: string }> {
  const res = await mcpPost(target.url, target.auth, body, { timeoutMs, headers: Object.fromEntries(session), fetch });
  const id = res.headers.get('mcp-session-id');
  if (id !== null && id !== '' && !session.has('mcp-session-id')) session.set('mcp-session-id', id);
  const text = await res.text().catch(() => '');
  checkStatus(res, target);
  return { res, text };
}

async function rpc(target: VendorTarget, session: Session, body: RpcBody, timeoutMs: number, fetch: FetchLike): Promise<Record<string, unknown>> {
  const { res, text } = await post(target, session, body, timeoutMs, fetch);
  const reply = messagesOf(text, res.headers.get('content-type') ?? '').find((message) => isRecord(message) && message.id === body.id && ('result' in message || 'error' in message));
  if (!isRecord(reply)) throw refused(`${target.url.hostname} answered, but not with an MCP reply`);
  if (isRecord(reply.error)) {
    const message = typeof reply.error.message === 'string' ? reply.error.message.slice(0, MESSAGE_MAX) : 'no message';
    throw new CallError('vendor_error', `The connector answered with an error: ${message}`);
  }
  return isRecord(reply.result) ? reply.result : {};
}

function endSession(target: VendorTarget, session: Session, fetch: FetchLike): void {
  if (!session.has('mcp-session-id')) return;
  fetch(target.url.toString(), { method: 'DELETE', redirect: 'manual', signal: AbortSignal.timeout(VENDOR_INIT_MS), headers: { ...authHeaders(target.auth), ...Object.fromEntries(session) } })
    .then((res) => res.body?.cancel())
    .catch((err: unknown) => {
      log.debug({ host: target.url.hostname, err: errMsg(err) }, 'mcp: the connector declined to end its session');
    });
}

function answerOf(result: Record<string, unknown>): VendorAnswer {
  const content = Array.isArray(result.content) ? result.content.filter((block): block is Record<string, unknown> => isRecord(block) && typeof block.type === 'string') : [];
  return { content, isError: result.isError === true, ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }) };
}

export async function callVendorTool(target: VendorTarget, tool: string, args: Record<string, unknown>, fetch: FetchLike): Promise<VendorAnswer> {
  const session: Session = new Map();
  try {
    const init = await rpc(target, session, INITIALIZE, VENDOR_INIT_MS, fetch);
    if (typeof init.protocolVersion !== 'string') throw refused(`${target.url.hostname} answered, but it does not speak MCP`);
    session.set('mcp-protocol-version', init.protocolVersion);
    await post(target, session, { jsonrpc: '2.0', method: 'notifications/initialized' }, VENDOR_INIT_MS, fetch);
    return answerOf(await rpc(target, session, { jsonrpc: '2.0', id: CALL_ID, method: 'tools/call', params: { name: tool, arguments: args } }, VENDOR_CALL_MS, fetch));
  } finally {
    endSession(target, session, fetch);
  }
}
