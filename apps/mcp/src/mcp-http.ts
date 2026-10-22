import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { readBodyBytes } from '@metro-labs/http/api-http';
import { tokenHashOf } from '@metro-labs/connectors/db/agent-tokens';
import type { DeliveryIdentity } from '@metro-labs/connectors/db/connector-delivery';
import type { McpDeps } from './deps.js';
import { answerMessage } from './rpc.js';
import { bearerToken } from './token.js';

export const MCP_BODY_MAX = 4 * 1024 * 1024;
const BATCH_MAX = 50;
const PATHS = new Set(['/', '/mcp']);

type Body = Record<string, unknown> | Record<string, unknown>[];

export function sendBody(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function unauthorized(res: ServerResponse): void {
  sendBody(res, 401, { error: 'An access key from the agent\'s page on metro.box, or the MCP token of its Metro, is required (Authorization: Bearer mcp_...). A revoked key no longer works.' }, { 'www-authenticate': 'Bearer' });
}

async function identityOf(req: IncomingMessage, deps: McpDeps): Promise<DeliveryIdentity | null> {
  const token = bearerToken(req.headers.authorization);
  return token === null ? null : deps.tokens.agentOf(tokenHashOf(token));
}

function parsedBody(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
}

const initializes = (messages: unknown[]): boolean => messages.some((message) => isRecord(message) && message.method === 'initialize');

const rpcFailure = (code: number, message: string): Record<string, unknown> => ({ jsonrpc: '2.0', id: null, error: { code, message } });

async function answer(req: IncomingMessage, res: ServerResponse, deps: McpDeps, identity: DeliveryIdentity): Promise<void> {
  const body = parsedBody(await readBodyBytes(req, MCP_BODY_MAX));
  if (body === undefined) {
    sendBody(res, 400, rpcFailure(-32700, 'Parse error'));
    return;
  }
  const batch = Array.isArray(body);
  const messages: unknown[] = batch ? body : [body];
  if (messages.length === 0 || messages.length > BATCH_MAX) {
    sendBody(res, 400, rpcFailure(-32600, `A batch carries 1 to ${String(BATCH_MAX)} messages`));
    return;
  }
  const replies = (await Promise.all(messages.map((message) => answerMessage({ deps, identity }, message)))).filter((reply): reply is Record<string, unknown> => reply !== null);
  const headers: Record<string, string> = initializes(messages) ? { 'mcp-session-id': randomBytes(16).toString('base64url') } : {};
  if (replies.length === 0) {
    res.writeHead(202, headers).end();
    return;
  }
  const reply: Body = batch ? replies : (replies[0] ?? {});
  sendBody(res, 200, reply, headers);
}

async function serve(req: IncomingMessage, res: ServerResponse, deps: McpDeps): Promise<void> {
  const identity = await identityOf(req, deps);
  if (identity === null) unauthorized(res);
  else await answer(req, res, deps, identity);
}

export function handleMcpRequest(req: IncomingMessage, res: ServerResponse, deps: McpDeps): boolean {
  if (!PATHS.has((req.url ?? '').split('?')[0] ?? '')) return false;
  if (req.method !== 'POST') {
    sendBody(res, 405, { error: 'This MCP endpoint answers POST only, with JSON.' }, { allow: 'POST' });
    return true;
  }
  serve(req, res, deps).catch((err: unknown) => {
    if (err instanceof ApiError) {
      sendBody(res, err.status, { error: err.message });
      return;
    }
    log.warn({ err: errMsg(err) }, 'mcp: request failed');
    sendBody(res, 500, { error: 'mcp.metro.box could not answer. Try again.' });
  });
  return true;
}
