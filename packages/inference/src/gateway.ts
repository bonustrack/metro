import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from '@metro-labs/core/log';
import { cameThroughProxy } from '@metro-labs/http/api-http';
import {
  bedrockBase,
  bedrockCount,
  bedrockMessages,
  forgetAdaptations,
  freshAdaptations,
  type Adaptations,
} from './bedrock.js';
import {
  addBeta,
  anthropicHeaders,
  GatewayError,
  holdLimitRefusal,
  SubscriptionRefused,
  loginHeaders,
  parseJson,
  pipeResponse,
  readBody,
  sendError,
  upstreamMessage,
  watchUpstream,
  type Held,
  type Watch,
  type Refusal,
} from './forward.js';
import { chainOf, forgetFallbackState, noteChoice, noteRefused, routesToTry, type Lane } from './fallback.js';
import {
  BINDING_BETA,
  cappedEffort,
  effortToApply,
  forgetLearnedThinking,
  helperRequest,
  learnAlwaysThinks,
  plannedEffort,
  requestKind,
  thinkingOff,
  withBlockBinding,
  withEffort,
  withThinkingFor,
  type RequestKind,
} from './effort.js';
import { currentAttempt, type OnCall } from './attempts.js';
import { measured } from './measure.js';
import { NAMED_MODELS, namedChoice, WORKERS, type Chosen } from './named.js';
import { helperSetup, notReady, pinnedRoute, resolveRoute, routeLabel, type Connection, type ModelSetup, type Route } from './model-config.js';
import { codexMessages, type CodexDeps } from './codex.js';
import { countTokens } from './subscription.js';
import { OPENROUTER_BASE } from './openrouter.js';
import { noteRoutewayRefusal, refusedWithPage, ROUTEWAY_BASE, routewayBody, routewayHeaders } from './routeway.js';
import { isRecord } from '@metro-labs/core/is-record';
import { forgetServed, noteServed } from './served.js';
import { forgetUsage, noteUsageHeaders, UsageScanner } from './usage.js';
import { fitToolSearch } from './tool-search.js';
import { providerText, siteOf } from './failures.js';

const GATEWAY_PREFIX = '/gateway';
const MESSAGES = '/v1/messages';
const COUNT = '/v1/messages/count_tokens';
const MODELS = '/v1/models';
const HELLO = '/api/hello';
const ANTHROPIC_API = 'https://api.anthropic.com';
const NO_ROUTE = "metro gateway: no model is set up for this agent yet: enroll it with its organization and choose a model on the organization's Gateway page";

export interface ModelDeps {
  setup: () => ModelSetup;
  anthropicBase?: string;
  bedrockBase?: string;
  openrouterBase?: string;
  routewayBase?: string;
  codex?: Partial<CodexDeps>;
  onCall?: OnCall;
  scope?: string;
  named?: boolean;
}

export interface GatewayDeps extends ModelDeps {
  identify: (key: string) => boolean;
}

const learned: Adaptations = freshAdaptations();

const noRefresh = (): Promise<Connection | null> => Promise.resolve(null);

export function resetGatewayState(): void {
  forgetServed();
  forgetFallbackState();
  forgetUsage();
  forgetAdaptations(learned);
  forgetLearnedThinking();
}

const keyOf = (req: IncomingMessage): string => {
  const raw = req.headers['x-metro-key'];
  return (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
};

function routesOf(setup: ModelSetup): Route[] {
  return [...(setup.primary === null ? [] : [setup.primary]), ...setup.fallbacks].flatMap((ref) => {
    const conn = setup.connections.find((c) => c.id === ref.connection);
    const model = ref.model === '' ? (conn?.model ?? '') : ref.model;
    return conn === undefined || model === '' ? [] : [{ connection: conn, model }];
  });
}

function modelsBody(setup: ModelSetup): Record<string, unknown> {
  const listed = routesOf(setup)
    .filter((r) => r.connection.provider !== 'anthropic')
    .map((r) => ({ id: routeLabel(r), display_name: `${r.connection.label} · ${r.model}`, description: 'Through metro' }));
  const data = listed.filter((m, at) => listed.findIndex((o) => o.id === m.id) === at);
  return { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null };
}

const noRoute = (): never => {
  throw new GatewayError(503, 'api_error', NO_ROUTE);
};

function requestedModel(body: Record<string, unknown>): string {
  const model = body.model;
  if (typeof model !== 'string' || model === '') throw new GatewayError(400, 'invalid_request_error', 'model is required');
  return model;
}

interface Payloads {
  metro: Buffer;
  asSent: Buffer | null;
  bound: boolean;
}

interface Shaped {
  raw: Buffer;
  sent: Record<string, unknown>;
  shaped: Record<string, unknown>;
  bind: boolean;
}

function anthropicPayloads({ raw, sent, shaped, bind }: Shaped, model: string): Payloads {
  const runnable = withThinkingFor(sent, model);
  const rewrite = runnable !== sent || (typeof sent.model === 'string' && sent.model !== model);
  const asSent = rewrite ? Buffer.from(JSON.stringify({ ...runnable, model })) : raw;
  const fitted = withThinkingFor(shaped, model);
  const bound = bind ? withBlockBinding(fitted) : fitted;
  if (bound === sent) return { metro: asSent, asSent: null, bound: false };
  return { metro: Buffer.from(JSON.stringify(rewrite ? { ...bound, model } : bound)), asSent, bound: bind && bound !== shaped };
}

type Send = (payload: Buffer, headers: Record<string, string>) => Promise<Response>;

async function asAnthropicWants(send: Send, base: Record<string, string>, payloads: Payloads, connection: string, model: string): Promise<Response> {
  const { metro, asSent, bound } = payloads;
  const upstream = await send(metro, bound ? addBeta(base, BINDING_BETA) : base);
  if (upstream.status !== 400 || asSent === null) return upstream;
  const reason = providerText(upstreamMessage(await upstream.text().catch(() => ''), ''));
  log.warn({ connection, model, reason }, 'gateway: the provider refused the request metro shaped, so it was sent again as Claude Code wrote it');
  return send(asSent, base);
}

async function refusedThinkingOff(upstream: Response, shaped: Record<string, unknown>, model: string): Promise<boolean> {
  if (upstream.status !== 400 || !thinkingOff(shaped)) return false;
  if (!learnAlwaysThinks(model, upstreamMessage(await upstream.clone().text(), ''))) return false;
  await upstream.body?.cancel();
  log.info({ model }, 'gateway: this model cannot run with thinking off, so metro leaves that setting out for it from now on');
  return true;
}

async function refusedSubscription(conn: Connection, upstream: Response, watch: Watch): Promise<void> {
  if (conn.apiKey !== '' || upstream.status !== 401) return;
  await upstream.body?.cancel();
  watch.stop();
  throw new SubscriptionRefused(conn.label);
}

async function shapedAttempt(send: Send, base: Record<string, string>, body: Shaped, route: Route): Promise<Response> {
  const shape = (): Promise<Response> => asAnthropicWants(send, base, anthropicPayloads(body, route.model), route.connection.label, route.model);
  const first = await shape();
  return (await refusedThinkingOff(first, body.shaped, route.model)) ? shape() : first;
}

const sender = (url: string, watch: Watch): Send => (payload, headers) =>
  fetch(url, { method: 'POST', headers, body: new Uint8Array(payload), signal: watch.signal, redirect: 'manual' });

const upstreamPath = (req: IncomingMessage): string => {
  const url = req.url ?? '';
  return url.startsWith(`${GATEWAY_PREFIX}/`) ? url.slice(GATEWAY_PREFIX.length) : url;
};

async function toAnthropic(req: IncomingMessage, res: ServerResponse, body: Shaped, route: Route, deps: ModelDeps): Promise<void> {
  const conn = route.connection;
  const watch = watchUpstream(res);
  const send = sender(`${deps.anthropicBase ?? ANTHROPIC_API}${upstreamPath(req)}`, watch);
  const upstream = await shapedAttempt(send, conn.apiKey !== '' ? anthropicHeaders(req, conn.apiKey) : loginHeaders(req, conn.claudeToken), body, route);
  await refusedSubscription(conn, upstream, watch);
  noteRefusal(conn.label, route.model, upstream);
  noteUsageHeaders('anthropic', conn.id, upstream.headers);
  await pipeResponse(upstream, res, watch, { ownCredential: true, scanner: new UsageScanner(conn.id), site: siteOf(route) });
}

async function toRouteway(req: IncomingMessage, res: ServerResponse, body: Shaped, route: Route, deps: ModelDeps): Promise<void> {
  const conn = route.connection;
  const watch = watchUpstream(res);
  const send = sender(`${deps.routewayBase ?? ROUTEWAY_BASE}${upstreamPath(req)}`, watch);
  const sent = routewayBody(body.sent);
  const fitted: Shaped = { raw: sent === body.sent ? body.raw : Buffer.from(JSON.stringify(sent)), sent, shaped: routewayBody(body.shaped), bind: false };
  const upstream = await shapedAttempt(send, routewayHeaders(req, conn.apiKey), fitted, route);
  noteRefusal(conn.label, route.model, upstream);
  await noteRoutewayRefusal(upstream);
  await refusedWithPage(upstream, watch);
  await pipeResponse(upstream, res, watch, { keepalive: true, ownCredential: true, scanner: new UsageScanner(conn.id), site: siteOf(route) });
}

async function toOpenRouter(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>, route: Route, deps: ModelDeps): Promise<void> {
  const conn = route.connection;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: req.headers.accept ?? 'application/json',
    authorization: `Bearer ${conn.apiKey}`,
    'anthropic-version': typeof req.headers['anthropic-version'] === 'string' ? req.headers['anthropic-version'] : '2023-06-01',
    'http-referer': 'https://metro.box',
    'x-title': 'metro',
  };
  const beta = req.headers['anthropic-beta'];
  if (typeof beta === 'string' && beta !== '') headers['anthropic-beta'] = beta;
  const watch = watchUpstream(res);
  const upstream = await fetch(`${deps.openrouterBase ?? OPENROUTER_BASE}${MESSAGES}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(openrouterBody(body, route.model, conn.zdr)),
    signal: watch.signal,
    redirect: 'manual',
  });
  noteRefusal(conn.label, route.model, upstream);
  await pipeResponse(upstream, res, watch, { keepalive: true, ownCredential: true, scanner: new UsageScanner(conn.id), site: siteOf(route) });
}

function openrouterBody(body: Record<string, unknown>, model: string, zdr: boolean): Record<string, unknown> {
  const sent: Record<string, unknown> = { ...body, model };
  if (thinkingOff(body)) delete sent.thinking;
  const effort = effortToApply(body);
  if (effort !== null) sent.reasoning = { ...(isRecord(body.reasoning) ? body.reasoning : {}), effort: cappedEffort(effort) };
  if (!zdr) return sent;
  const provider = isRecord(body.provider) ? body.provider : {};
  return { ...sent, provider: { ...provider, zdr: true } };
}

function noteRefusal(connection: string, model: string, upstream: Response): void {
  if (!upstream.ok) log.warn({ connection, model, status: upstream.status }, 'gateway: the provider refused the request');
}

async function toCodex(req: IncomingMessage, res: ServerResponse, path: string, body: Record<string, unknown>, route: Route, deps: ModelDeps): Promise<void> {
  if (path === COUNT) countTokens(res, body);
  else await codexMessages(req, res, body, route.model, route.connection, { refresh: noRefresh, ...deps.codex }, watchUpstream(res));
}

function shapedFor(req: IncomingMessage, sent: Record<string, unknown>, setup: ModelSetup, kind: RequestKind): Record<string, unknown> {
  const effort = plannedEffort(req, sent, setup.effort, kind);
  return effort === null ? sent : withEffort(sent, effort);
}

function chosenChain(req: IncomingMessage, sent: Record<string, unknown>, setup: ModelSetup, requested: string): Chosen {
  const helpers = helperRequest(req, sent) ? helperSetup(setup) : null;
  if (helpers === null) return { lane: 'main', setup, primary: resolveRoute(requested, setup) ?? noRoute() };
  return { lane: 'helpers', setup: helpers, primary: pinnedRoute(requested, helpers) ?? noRoute() };
}

const bytesOf = (raw: Buffer, parsed: Record<string, unknown>, sent: Record<string, unknown>): Buffer => (sent === parsed ? raw : Buffer.from(JSON.stringify(sent)));

interface Request {
  path: string;
  lane: Lane;
  kind: RequestKind;
  raw: Buffer;
  parsed: Record<string, unknown>;
  sent: Record<string, unknown>;
  body: Record<string, unknown>;
  setup: ModelSetup;
}

async function attempt(req: IncomingMessage, res: ServerResponse, ask: Request, route: Route, deps: ModelDeps): Promise<void> {
  const { path, body } = ask;
  const conn = route.connection;
  log.info({ route: routeLabel(route), connection: conn.label, path }, 'gateway: routing');
  const reason = notReady(route);
  if (reason !== null) throw new GatewayError(400, 'invalid_request_error', reason);
  if (path === MESSAGES) noteServed({ connection: conn.id, provider: conn.provider, model: route.model, at: new Date().toISOString() }, deps.scope);
  if (conn.provider === 'bedrock') {
    const up = { settings: conn, base: deps.bedrockBase ?? bedrockBase(conn.region), learned, watch: watchUpstream(res) };
    if (path === COUNT) await bedrockCount(req, res, body, route.model, up);
    else await bedrockMessages(req, res, body, route.model, up);
    return;
  }
  if (conn.provider === 'openrouter') {
    if (path === COUNT) throw new GatewayError(404, 'not_found_error', 'OpenRouter does not count tokens');
    await toOpenRouter(req, res, body, route, deps);
    return;
  }
  if (conn.provider === 'codex') {
    await toCodex(req, res, path, body, route, deps);
    return;
  }
  const shaped: Shaped = { raw: bytesOf(ask.raw, ask.parsed, ask.sent), sent: ask.sent, shaped: body, bind: true };
  await (conn.provider === 'routeway' ? toRouteway : toAnthropic)(req, res, shaped, route, deps);
}

async function heldAttempt(req: IncomingMessage, held: Held, ask: Request, route: Route, deps: ModelDeps): Promise<Refusal | null> {
  try {
    await attempt(req, held.res, ask, route, deps);
  } catch (err) {
    if (!(err instanceof SubscriptionRefused)) throw err;
    currentAttempt()?.answered(401);
    return { status: 401, headers: new Headers() };
  }
  return held.refusal();
}

async function dispatch(req: IncomingMessage, res: ServerResponse, path: string, deps: ModelDeps): Promise<void> {
  const setup = deps.setup();
  const raw = await readBody(req);
  const parsed = parseJson(raw);
  const sent = fitToolSearch(req, parsed);
  const requested = requestedModel(sent);
  const named = deps.named === true ? namedChoice(requested, setup) : null;
  const { lane, setup: chain, primary } = named ?? chosenChain(req, sent, setup, requested);
  const kind: RequestKind = named === null ? requestKind(req, sent) : requested === WORKERS ? 'subagent' : 'main';
  const ask: Request = { path, lane, kind, raw, parsed, sent, body: shapedFor(req, sent, setup, kind), setup };
  const routes = routesToTry(chainOf(primary, chain, requested));
  for (const [at, route] of routes.entries()) {
    const next = routes[at + 1];
    if (path === MESSAGES) noteChoice(primary, route, lane, Date.now(), deps.scope);
    if (next === undefined) {
      await measured(res, ask, route, at, deps.onCall, (out) => attempt(req, out, ask, route, deps));
      return;
    }
    const held = holdLimitRefusal(res);
    const refusal = await measured(held.res, ask, route, at, deps.onCall, (out) => heldAttempt(req, { res: out, refusal: held.refusal }, ask, route, deps));
    if (refusal === null) return;
    noteRefused(route, refusal.status, refusal.headers, next);
  }
}

function failed(res: ServerResponse, err: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (err instanceof GatewayError) {
    sendError(res, err.status, err.kind, err.message);
    return;
  }
  log.warn({ err: errMsg(err) }, 'gateway: request failed');
  sendError(res, 502, 'api_error', `metro gateway: ${errMsg(err)}`);
}

export function answerModels(req: IncomingMessage, res: ServerResponse, path: string, deps: ModelDeps): void {
  if (req.method === 'GET' && path === MODELS) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(deps.named === true ? NAMED_MODELS : modelsBody(deps.setup())));
    return;
  }
  if (req.method === 'POST' && (path === MESSAGES || path === COUNT)) {
    dispatch(req, res, path, deps).catch((err: unknown) => {
      failed(res, err);
    });
    return;
  }
  sendError(res, 404, 'not_found_error', 'not found');
}

export function handleGatewayRequest(req: IncomingMessage, res: ServerResponse, deps: GatewayDeps): boolean {
  const full = req.url ?? '';
  if (full !== GATEWAY_PREFIX && !full.startsWith(`${GATEWAY_PREFIX}/`)) return false;
  const path = (full.split('?')[0] ?? '').slice(GATEWAY_PREFIX.length);
  if (req.method === 'HEAD' && path === HELLO) {
    res.writeHead(200).end();
    return true;
  }
  if (cameThroughProxy(req)) sendError(res, 401, 'authentication_error', 'metro gateway: the agent key works only on this machine, not through its public address');
  else if (keyOf(req) !== '' && deps.identify(keyOf(req))) answerModels(req, res, path, deps);
  else sendError(res, 401, 'authentication_error', 'metro gateway: no agent key (x-metro-key); start the agent with metro agent');
  return true;
}
