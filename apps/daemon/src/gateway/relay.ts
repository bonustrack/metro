import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from '@metro-labs/core/log';
import { cameThroughProxy } from '@metro-labs/http/api-http';
import { forwardedHeaders, pipeResponse, readBody, sendError, watchUpstream } from '@metro-labs/inference/forward';
import { agentsDir } from '../agents/files.js';
import { agentIdForKey } from '../agents/keys.js';
import { usableServerUrl } from '../mcp-server/config.js';
import { reregisterMcpToken } from '../mcp-server/link.js';
import { readMcpToken } from '../mcp-server/token.js';

const PREFIX = '/gateway';
const HELLO = '/api/hello';
const ROUTES = new Set(['GET /v1/models', 'POST /v1/messages', 'POST /v1/messages/count_tokens']);
const DEFAULT_URL = 'https://gateway.metro.box';
const DROPPED = ['authorization', 'x-api-key', 'cookie'];
const NOT_LINKED = 'metro gateway: this agent is not linked to its organization yet, so it cannot reach its models. It links once an admin of the organization opens its page on metro.box.';
const NOT_ACCEPTED = 'metro gateway: gateway.metro.box did not accept this agent yet. It registers again; Claude Code retries.';
const NO_GATEWAY = 'metro gateway: this Metro has no model gateway, since METRO_GATEWAY_URL is empty or not an https url.';
const UNREACHABLE = 'metro gateway: gateway.metro.box could not be reached. Claude Code retries.';

export interface RelayDeps {
  url: string | null;
  identify: (key: string) => boolean;
  token: () => string | null;
  reregister: () => void;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

let refused: string | undefined;

export function gatewayUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.METRO_GATEWAY_URL?.trim() ?? DEFAULT_URL;
  if (raw === '') return null;
  if (usableServerUrl(raw)) return raw.replace(/\/+$/, '');
  if (refused !== raw) {
    refused = raw;
    log.warn({ url: raw }, 'gateway: METRO_GATEWAY_URL must be an https url (http only on this machine), so this box has no model gateway');
  }
  return null;
}

const keyOf = (req: IncomingMessage): string => {
  const raw = req.headers['x-metro-key'];
  return (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
};

function upstreamHeaders(req: IncomingMessage, token: string): Record<string, string> {
  const headers = forwardedHeaders(req);
  for (const name of DROPPED) Reflect.deleteProperty(headers, name);
  return { ...headers, authorization: `Bearer ${token}` };
}

function targetOf(deps: RelayDeps): { url: string; token: string } | string {
  if (deps.url === null) return NO_GATEWAY;
  const token = deps.token();
  return token === null ? NOT_LINKED : { url: deps.url, token };
}

async function relay(req: IncomingMessage, res: ServerResponse, path: string, deps: RelayDeps): Promise<void> {
  const target = targetOf(deps);
  if (typeof target === 'string') {
    req.resume();
    sendError(res, 503, 'api_error', target);
    return;
  }
  const body = req.method === 'POST' ? await readBody(req) : undefined;
  const watch = watchUpstream(res);
  let upstream: Response;
  try {
    upstream = await (deps.fetch ?? fetch)(`${target.url}${path}`, {
      method: req.method ?? 'GET',
      headers: upstreamHeaders(req, target.token),
      ...(body === undefined ? {} : { body: new Uint8Array(body) }),
      signal: watch.signal,
      redirect: 'manual',
    });
  } catch (err) {
    watch.stop();
    log.warn({ err: errMsg(err) }, 'gateway: gateway.metro.box could not be reached');
    sendError(res, 502, 'api_error', UNREACHABLE);
    return;
  }
  if (upstream.status === 401) {
    await upstream.body?.cancel();
    watch.stop();
    deps.reregister();
    sendError(res, 503, 'api_error', NOT_ACCEPTED);
    return;
  }
  await pipeResponse(upstream, res, watch);
}

function refusal(req: IncomingMessage, path: string, deps: RelayDeps): [number, string, string] | null {
  if (cameThroughProxy(req)) return [401, 'authentication_error', 'metro gateway: the agent key works only on this machine, not through its public address'];
  if (keyOf(req) === '' || !deps.identify(keyOf(req))) return [401, 'authentication_error', 'metro gateway: no agent key (x-metro-key); start the agent with metro agent'];
  return ROUTES.has(`${req.method ?? 'GET'} ${path}`) ? null : [404, 'not_found_error', 'not found'];
}

export function handleGatewayRelay(req: IncomingMessage, res: ServerResponse, deps: RelayDeps): boolean {
  const full = req.url ?? '';
  if (full !== PREFIX && !full.startsWith(`${PREFIX}/`)) return false;
  const [path = '', query] = full.slice(PREFIX.length).split('?', 2);
  if (req.method === 'HEAD' && path === HELLO) {
    res.writeHead(200).end();
    return true;
  }
  const refused = refusal(req, path, deps);
  if (refused !== null) {
    req.resume();
    sendError(res, ...refused);
    return true;
  }
  relay(req, res, query === undefined ? path : `${path}?${query}`, deps).catch((err: unknown) => {
    log.warn({ err: errMsg(err) }, 'gateway: relaying a request failed');
    if (!res.headersSent) sendError(res, 502, 'api_error', UNREACHABLE);
    else res.end();
  });
  return true;
}

export function boxGatewayHandler(): (req: IncomingMessage, res: ServerResponse) => boolean {
  const url = gatewayUrl();
  if (url === null) log.warn('gateway: METRO_GATEWAY_URL is empty, so model requests are refused');
  else log.info({ url }, 'gateway: model requests go through gateway.metro.box');
  const deps: RelayDeps = { url, identify: (key) => agentIdForKey(key) !== undefined, token: () => readMcpToken(agentsDir()), reregister: reregisterMcpToken };
  return (req, res) => handleGatewayRelay(req, res, deps);
}
