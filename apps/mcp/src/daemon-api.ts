import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { readBodyBytes } from '@metro-labs/http/api-http';
import { isRecord } from '@metro-labs/core/is-record';
import { MCP_PATHS, mailTakenOf, mcpAnswerOf, mcpTokenHashOf, type McpApproval, type McpMail } from '@metro-labs/http/mcp-server-protocol';
import { AgentKeyMissing, refuseBrowser } from '@metro-labs/connectors/agent-auth';
import type { AgentKeyRow } from '@metro-labs/connectors/db/agent-keys';
import type { DeliveredApproval } from '@metro-labs/connectors/db/mcp-approvals';
import { agentConnectors } from './catalog.js';
import type { McpDeps } from './deps.js';
import { takeMail, waitingMail } from './mail.js';
import { sendBody } from './mcp-http.js';

const BODY_MAX = 8192;
const ROUTES = new Set<string>(Object.values(MCP_PATHS));

interface Signed {
  identity: AgentKeyRow;
  body: unknown;
}

class InputError extends ApiError {}

function bodyOf(bytes: Buffer): unknown {
  const text = bytes.toString('utf8').trim();
  if (text === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new InputError('The body must be JSON.', 400);
  }
}

function input<T>(read: () => T): T {
  try {
    return read();
  } catch (err) {
    throw new InputError(errMsg(err), 400);
  }
}

async function signed(req: IncomingMessage, deps: McpDeps): Promise<Signed> {
  refuseBrowser(req);
  const bytes = await readBodyBytes(req, BODY_MAX);
  const proof = deps.auth.proofOf(req);
  const identity = await deps.keys.find(proof.keyId);
  if (identity === null) throw new AgentKeyMissing();
  deps.auth.accept(req, bytes, proof, identity.signingKey, identity.owner);
  await deps.nonces.consume(proof, identity.owner);
  return { identity, body: bodyOf(bytes) };
}

function originOf(row: DeliveredApproval): Pick<McpApproval, 'origin' | 'keyLabel'> {
  if (row.origin === 'box') return { origin: 'box' };
  if (row.origin !== 'key') return {};
  return row.keyLabel === null ? { origin: 'key' } : { origin: 'key', keyLabel: row.keyLabel };
}

async function wireOf(deps: McpDeps, identity: AgentKeyRow, rows: DeliveredApproval[]): Promise<McpApproval[]> {
  if (rows.length === 0) return [];
  const keys = new Map((await agentConnectors(deps, identity)).map((connector) => [connector.id, connector.key]));
  return rows.map((row) => ({ id: row.id, connector: keys.get(row.connector) ?? row.connector, tool: row.tool, preview: row.preview, requestedAt: row.requestedAt, ...originOf(row) }));
}

interface Pending {
  approvals: McpApproval[];
  mail?: McpMail[];
}

let mailQuiet = false;

async function mailFor(deps: McpDeps, identity: AgentKeyRow): Promise<McpMail[]> {
  try {
    const mail = await waitingMail(deps, identity);
    mailQuiet = false;
    return mail;
  } catch (err) {
    if (!mailQuiet) log.warn({ err: errMsg(err) }, 'mcp: waiting mail could not be read, so the box gets approvals only until it can');
    mailQuiet = true;
    return [];
  }
}

async function pendingFor(deps: McpDeps, identity: AgentKeyRow, wantsMail: boolean, signal: AbortSignal): Promise<Pending> {
  const hold = AbortSignal.any([signal, AbortSignal.timeout(deps.approvalHoldMs)]);
  while (!signal.aborted) {
    const rows = await deps.approvals.deliver(identity, deps.now());
    const mail = wantsMail ? await mailFor(deps, identity) : [];
    if (rows.length > 0 || mail.length > 0) return { approvals: await wireOf(deps, identity, rows), ...(wantsMail ? { mail } : {}) };
    if (hold.aborted) break;
    await deps.waiters.wait(identity.agent, deps.approvalPollMs, hold);
  }
  return { approvals: [], ...(wantsMail ? { mail: [] } : {}) };
}

async function route(path: string, req: IncomingMessage, deps: McpDeps, signal: AbortSignal): Promise<unknown> {
  const { identity, body } = await signed(req, deps);
  if (path === MCP_PATHS.token) {
    await deps.tokens.setHash(identity, input(() => mcpTokenHashOf(body)));
    log.info({ agent: identity.agent, owner: identity.owner }, 'mcp: an agent set its MCP token');
    return { ok: true };
  }
  if (path === MCP_PATHS.approvals) return pendingFor(deps, identity, isRecord(body) && body.mail === true, signal);
  if (path === MCP_PATHS.mailTaken) return { ok: true, taken: await takeMail(deps, identity, input(() => mailTakenOf(body))) };
  const { id, decision } = input(() => mcpAnswerOf(body));
  if (!(await deps.approvals.answer(identity, id, decision, deps.now()))) throw new ApiError('No pending approval has that id.', 404);
  log.info({ agent: identity.agent, id, decision }, 'mcp: the owner answered an approval');
  return { ok: true };
}

function failed(res: ServerResponse, err: unknown): void {
  if (err instanceof AgentKeyMissing) sendBody(res, err.status, { error: err.message, code: 'agent_key_missing' });
  else if (err instanceof ApiError) sendBody(res, err.status, { error: err.message });
  else {
    log.warn({ err: errMsg(err) }, 'mcp: a daemon request failed');
    sendBody(res, 503, { error: 'mcp.metro.box could not answer. Try again.' });
  }
}

export function handleDaemonRequest(req: IncomingMessage, res: ServerResponse, deps: McpDeps): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (!ROUTES.has(path)) return false;
  if (req.method !== 'POST') {
    sendBody(res, 405, { error: 'method not allowed' }, { allow: 'POST' });
    return true;
  }
  const stop = new AbortController();
  res.on('close', () => {
    stop.abort();
  });
  route(path, req, deps, stop.signal)
    .then((body) => {
      sendBody(res, 200, body);
    })
    .catch((err: unknown) => {
      failed(res, err);
    });
  return true;
}
