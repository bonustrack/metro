import { isRecord } from '@metro-labs/core/is-record';
import { errMsg } from '@metro-labs/core/log';
import { agentsDir } from '../agents/files.js';
import { mcpServerUrl } from './config.js';
import { reregisterMcpToken } from './link.js';
import { readMcpToken } from './token.js';

export interface ServerDeps {
  url?: string | null;
  token?: string | null;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  reregister?: () => void;
}

export type ServerAnswer =
  | { ok: true; result: unknown }
  | { ok: false; reason: 'unset' }
  | { ok: false; reason: 'unavailable'; detail: string }
  | { ok: false; reason: 'refused'; message: string };

let nextId = 1;

const unavailable = (detail: string): ServerAnswer => ({ ok: false, reason: 'unavailable', detail });

async function bodyOf(res: Response): Promise<ServerAnswer> {
  let body: unknown;
  try {
    body = JSON.parse(await res.text());
  } catch (err) {
    return unavailable(`unreadable answer: ${errMsg(err)}`);
  }
  if (isRecord(body) && isRecord(body.error))
    return { ok: false, reason: 'refused', message: typeof body.error.message === 'string' ? body.error.message.slice(0, 500) : 'refused' };
  return isRecord(body) && Object.hasOwn(body, 'result') ? { ok: true, result: body.result } : unavailable('no JSON-RPC result');
}

interface Target {
  url: string;
  token: string;
}

function targetOf(deps: ServerDeps): Target | null {
  const url = deps.url === undefined ? mcpServerUrl() : deps.url;
  const token = deps.token === undefined ? readMcpToken(agentsDir()) : deps.token;
  return url === null || token === null ? null : { url, token };
}

export async function askServer(method: string, params: Record<string, unknown>, timeoutMs: number, deps: ServerDeps = {}): Promise<ServerAnswer> {
  const target = targetOf(deps);
  if (target === null) return { ok: false, reason: 'unset' };
  const { url, token } = target;
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(`${url}/`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return unavailable(errMsg(err));
  }
  if (res.status === 401) (deps.reregister ?? reregisterMcpToken)();
  if (!res.ok) return unavailable(`HTTP ${String(res.status)}`);
  return bodyOf(res);
}
