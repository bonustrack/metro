import type { IncomingMessage, ServerResponse } from 'node:http';
import { newId } from '@metro-labs/core/ids';
import { errMsg, log } from '@metro-labs/core/log';
import { METRO_VERSION } from '@metro-labs/core/version';
import type { NewModelCall } from '@metro-labs/connectors/db/model-calls';
import type { AttemptCall } from '@metro-labs/inference/attempts';
import type { CodexDeps } from '@metro-labs/inference/codex';
import { answerModels, type ModelDeps } from '@metro-labs/inference/gateway';
import type { ModelSetup } from '@metro-labs/inference/model-config';
import { dropCredentials, keyOf, type Caller, type CallerOf } from './callers.js';
import { costMicros, type RoutewayPrices } from './prices.js';
import type { CallLog } from './recorder.js';
import type { Setups } from './setups.js';
import type { WindowSaver } from './windows.js';

const MESSAGES = '/v1/messages';
const PATHS = new Set([MESSAGES, '/v1/messages/count_tokens', '/v1/models']);
const MODEL_MAX = 256;
const NO_KEY = 'A Metro access key with the Gateway scope, or the agent token of a Metro, is required (x-api-key or Authorization: Bearer mcp_...). A revoked key no longer works.';

export type Upstreams = Pick<ModelDeps, 'anthropicBase' | 'bedrockBase' | 'openrouterBase' | 'routewayBase'> & { codex?: Omit<Partial<CodexDeps>, 'refresh'> };

export interface GatewayAppDeps {
  callerOf: CallerOf;
  setups: Setups;
  calls: CallLog;
  windows: WindowSaver;
  routeway: RoutewayPrices;
  now: () => number;
  upstreams?: Upstreams;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, type: string, message: string): void {
  sendJson(res, status, { type: 'error', error: { type, message } });
}

function rowOf(caller: Caller, call: AttemptCall, setup: ModelSetup, deps: GatewayAppDeps): NewModelCall {
  const conn = setup.connections.find((held) => held.id === call.connection);
  return {
    id: newId(),
    owner: caller.owner,
    agent: caller.agent,
    origin: caller.origin,
    token: caller.token,
    lane: call.lane,
    kind: caller.origin === 'key' ? 'external' : call.kind,
    connection: call.connection,
    provider: call.provider,
    model: call.model.slice(0, MODEL_MAX),
    attempt: call.attempt,
    outcome: call.outcome,
    status: call.status,
    inputTokens: call.tokens.input,
    outputTokens: call.tokens.output,
    cacheReadTokens: call.tokens.cacheRead,
    cacheWrite5mTokens: call.tokens.cacheWrite5m,
    cacheWrite1hTokens: call.tokens.cacheWrite1h,
    costMicros: costMicros(call, conn, deps.routeway),
    ms: call.ms,
    firstTokenMs: call.firstTokenMs,
    at: call.at,
  };
}

function noRouteRow(caller: Caller, at: number): NewModelCall {
  return {
    id: newId(),
    owner: caller.owner,
    agent: caller.agent,
    origin: caller.origin,
    token: caller.token,
    lane: 'main',
    kind: caller.origin === 'key' ? 'external' : 'main',
    connection: null,
    provider: null,
    model: '',
    attempt: 0,
    outcome: 'no_route',
    status: 503,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    costMicros: null,
    ms: 0,
    firstTokenMs: null,
    at,
  };
}

async function serve(req: IncomingMessage, res: ServerResponse, path: string, deps: GatewayAppDeps): Promise<void> {
  const token = keyOf(req);
  const caller = token === null ? null : await deps.callerOf(token);
  if (caller === null) {
    req.resume();
    sendError(res, 401, 'authentication_error', NO_KEY);
    return;
  }
  dropCredentials(req);
  const setup = await deps.setups.of(caller);
  let attempts = 0;
  const onCall = (call: AttemptCall): void => {
    attempts += 1;
    deps.windows.seen(caller.owner, call.connection);
    deps.calls.add(rowOf(caller, call, setup, deps));
  };
  if (path === MESSAGES)
    res.once('close', () => {
      if (attempts === 0 && res.statusCode === 503) deps.calls.add(noRouteRow(caller, deps.now()));
    });
  const { codex, ...bases } = deps.upstreams ?? {};
  answerModels(req, res, path, {
    ...bases,
    setup: () => setup,
    onCall,
    scope: `${caller.owner}\n${caller.agent}`,
    named: caller.origin === 'key',
    codex: { ...codex, refresh: (conn) => deps.setups.refresh(caller, conn) },
  });
}

function handleHealth(res: ServerResponse): void {
  sendJson(res, 200, { status: 'ok', version: METRO_VERSION, uptime: Math.round(process.uptime()) });
}

export function handleRequest(req: IncomingMessage, res: ServerResponse, deps: GatewayAppDeps): void {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (path === '/health' || path === '/healthz') {
    handleHealth(res);
    return;
  }
  if (!PATHS.has(path)) {
    req.resume();
    sendError(res, 404, 'not_found_error', 'not found');
    return;
  }
  serve(req, res, path, deps).catch((err: unknown) => {
    log.warn({ err: errMsg(err) }, 'gateway: a request failed');
    if (!res.headersSent) sendError(res, 500, 'api_error', 'gateway.metro.box could not answer this request. Try again in a moment.');
    else res.end();
  });
}
