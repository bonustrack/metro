import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from '@metro-labs/core/log';
import { agentIdForKey } from '../agents/keys.js';
import {
  assertBedrockReady,
  bedrockBase,
  bedrockCount,
  bedrockMessages,
  freshAdaptations,
  type Adaptations,
} from './bedrock.js';
import { addBeta, anthropicHeaders, forwardedHeaders, GatewayError, parseJson, pipeResponse, readBody, sendError, watchUpstream } from './forward.js';
import { BINDING_BETA, cappedEffort, effortToApply, plannedEffort, withBlockBinding, withEffort } from './effort.js';
import { notReady, readModelConfig, resolveRoute, routeLabel, setCodexAuth, setGeminiAuth, writeModelConfig, type Connection, type ModelConfig, type Route } from './model-config.js';
import { codexCount, codexMessages, freshCodexState } from './codex.js';
import { freshGeminiState, geminiCount, geminiMessages } from './gemini.js';
import type { GeminiDeps } from './gemini.js';
import type { CodexDeps } from './codex.js';
import type { GeminiTokens } from './gemini-auth.js';
import { OPENROUTER_BASE } from './openrouter.js';
import { isRecord } from '@metro-labs/core/is-record';
import { forgetServed, noteServed } from './served.js';
import { forgetUsage, noteUsageHeaders, UsageScanner } from './usage.js';
import type { CodexTokens } from './codex-auth.js';

export const GATEWAY_PREFIX = '/gateway';
export const ANTHROPIC_BASE = 'https://api.anthropic.com';
const MESSAGES = '/v1/messages';
const COUNT = '/v1/messages/count_tokens';
const MODELS = '/v1/models';
const HELLO = '/api/hello';

export interface GatewayDeps {
  config: () => ModelConfig;
  identify?: (key: string) => boolean;
  anthropicBase?: string;
  bedrockBase?: string;
  openrouterBase?: string;
  codex?: Partial<CodexDeps>;
  gemini?: Partial<GeminiDeps>;
}

const learned: Adaptations = freshAdaptations();
const codexState = freshCodexState();
const geminiState = freshGeminiState();

export function resetGatewayState(): void {
  forgetServed();
  forgetUsage();
  learned.fields.clear();
  learned.dropBetas = false;
  Object.assign(codexState, freshCodexState());
  Object.assign(geminiState, freshGeminiState());
}

const saveCodexTokens = (id: string, tokens: CodexTokens): void => {
  writeModelConfig(setCodexAuth(readModelConfig(), id, tokens));
};

const saveGeminiTokens = (id: string, tokens: GeminiTokens): void => {
  writeModelConfig(setGeminiAuth(readModelConfig(), id, tokens));
};

const keyOf = (req: IncomingMessage): string => {
  const raw = req.headers['x-metro-key'];
  return (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
};

const defaultIdentify = (key: string): boolean => key !== '' && agentIdForKey(key) !== undefined;

function modelsBody(cfg: ModelConfig): Record<string, unknown> {
  const data = cfg.connections
    .filter((c) => c.provider !== 'anthropic' && c.model !== '')
    .map((c) => ({ id: `${c.provider}:${c.model}`, display_name: `${c.label} · ${c.model}`, description: 'Through metro' }));
  return { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null };
}

const PASSTHROUGH: Connection = { id: 'passthrough', provider: 'anthropic', label: 'Claude Code login', model: '', apiKey: '', region: '', zdr: false, codex: null, gemini: null };

const passthrough = (body: Record<string, unknown>): Route => ({ connection: PASSTHROUGH, model: requestedModel(body) });

function requestedModel(body: Record<string, unknown>): string {
  const model = body.model;
  if (typeof model !== 'string' || model === '') throw new GatewayError(400, 'invalid_request_error', 'model is required');
  return model;
}

const standsInFor = (req: IncomingMessage): boolean => {
  const metroKey = req.headers['x-metro-key'];
  return typeof metroKey === 'string' && metroKey !== '' && req.headers.authorization === `Bearer ${metroKey}`;
};

interface Payloads {
  metro: Buffer;
  asSent: Buffer | null;
  bound: boolean;
}

function anthropicPayloads(raw: Buffer, sent: Record<string, unknown>, shaped: Record<string, unknown>, model: string): Payloads {
  const rewrite = typeof sent.model === 'string' && sent.model !== model;
  const asSent = rewrite ? Buffer.from(JSON.stringify({ ...sent, model })) : raw;
  const bound = withBlockBinding(shaped);
  if (bound === sent) return { metro: asSent, asSent: null, bound: false };
  return { metro: Buffer.from(JSON.stringify(rewrite ? { ...bound, model } : bound)), asSent, bound: bound !== shaped };
}

type Send = (payload: Buffer, headers: Record<string, string>) => Promise<Response>;

async function asAnthropicWants(send: Send, base: Record<string, string>, payloads: Payloads, connection: string, model: string): Promise<Response> {
  const { metro, asSent, bound } = payloads;
  const upstream = await send(metro, bound ? addBeta(base, BINDING_BETA) : base);
  if (upstream.status !== 400 || asSent === null) return upstream;
  await upstream.body?.cancel();
  log.warn({ connection, model }, 'gateway: Anthropic refused the request metro shaped, so it was sent again as Claude Code wrote it');
  return send(asSent, base);
}

async function toAnthropic(
  req: IncomingMessage,
  res: ServerResponse,
  raw: Buffer,
  sent: Record<string, unknown>,
  shaped: Record<string, unknown>,
  route: Route,
  deps: GatewayDeps,
): Promise<void> {
  const conn = route.connection;
  const url = `${deps.anthropicBase ?? ANTHROPIC_BASE}${(req.url ?? '').slice(GATEWAY_PREFIX.length)}`;
  const key = conn.apiKey;
  if (key === '' && standsInFor(req))
    throw new GatewayError(
      403,
      'permission_error',
      'Claude Code on this machine has no Anthropic login of its own; choose Bedrock, OpenRouter, Codex or Gemini on the Model page, or sign in on the Claude tab',
    );
  const watch = watchUpstream(res);
  const base = key === '' ? forwardedHeaders(req) : anthropicHeaders(req, key);
  const send = (payload: Buffer, headers: Record<string, string>): Promise<Response> =>
    fetch(url, { method: 'POST', headers, body: new Uint8Array(payload), signal: watch.signal, redirect: 'manual' });
  const upstream = await asAnthropicWants(send, base, anthropicPayloads(raw, sent, shaped, route.model), conn.label, route.model);
  noteRefusal(conn.label, route.model, upstream);
  noteUsageHeaders('anthropic', conn.id, upstream.headers);
  const scanner = new UsageScanner(conn.id);
  await pipeResponse(upstream, res, watch, key === '' ? { scanner } : { ownCredential: true, scanner });
}

async function toOpenRouter(
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown>,
  route: Route,
  cfg: ModelConfig,
  deps: GatewayDeps,
): Promise<void> {
  const conn = route.connection;
  const reason = notReady(cfg, conn);
  if (reason !== null) throw new GatewayError(400, 'invalid_request_error', reason);
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
  await pipeResponse(upstream, res, watch, { keepalive: true, ownCredential: true, scanner: new UsageScanner(conn.id) });
}

const thinkingOff = (body: Record<string, unknown>): boolean => isRecord(body.thinking) && body.thinking.type === 'disabled';

export function openrouterBody(body: Record<string, unknown>, model: string, zdr: boolean): Record<string, unknown> {
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

async function toSubscription(req: IncomingMessage, res: ServerResponse, path: string, body: Record<string, unknown>, route: Route, deps: GatewayDeps): Promise<void> {
  const conn = route.connection;
  if (conn.provider === 'gemini') {
    if (path === COUNT) geminiCount(res, body);
    else await geminiMessages(req, res, body, route.model, conn, { save: saveGeminiTokens, ...deps.gemini }, geminiState, watchUpstream(res));
    return;
  }
  if (path === COUNT) codexCount(res, body);
  else await codexMessages(req, res, body, route.model, conn, { save: saveCodexTokens, ...deps.codex }, codexState, watchUpstream(res));
}

function shapedFor(req: IncomingMessage, sent: Record<string, unknown>): Record<string, unknown> {
  const effort = plannedEffort(req, sent);
  return effort === null ? sent : withEffort(sent, effort);
}

async function dispatch(req: IncomingMessage, res: ServerResponse, path: string, deps: GatewayDeps): Promise<void> {
  const cfg = deps.config();
  const raw = await readBody(req);
  const sent = parseJson(raw);
  const body = shapedFor(req, sent);
  const route = resolveRoute(requestedModel(body), cfg) ?? passthrough(body);
  const conn = route.connection;
  log.info({ route: routeLabel(route), connection: conn.label, path }, 'gateway: routing');
  if (path === MESSAGES) noteServed({ connection: conn.id, provider: conn.provider, model: route.model, at: new Date().toISOString() });
  if (conn.provider === 'bedrock') {
    assertBedrockReady(conn);
    const up = { settings: conn, base: deps.bedrockBase ?? bedrockBase(conn.region), learned, watch: watchUpstream(res) };
    if (path === COUNT) await bedrockCount(req, res, body, route.model, up);
    else await bedrockMessages(req, res, body, route.model, up);
    return;
  }
  if (conn.provider === 'openrouter') {
    if (path === COUNT) throw new GatewayError(404, 'not_found_error', 'OpenRouter does not count tokens');
    await toOpenRouter(req, res, body, route, cfg, deps);
    return;
  }
  if (conn.provider === 'codex' || conn.provider === 'gemini') {
    await toSubscription(req, res, path, body, route, deps);
    return;
  }
  await toAnthropic(req, res, raw, sent, body, route, deps);
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

function answer(req: IncomingMessage, res: ServerResponse, path: string, deps: GatewayDeps): void {
  if (req.method === 'GET' && path === MODELS) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(modelsBody(deps.config())));
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
  if ((deps.identify ?? defaultIdentify)(keyOf(req))) answer(req, res, path, deps);
  else sendError(res, 401, 'authentication_error', 'metro gateway: no agent key (x-metro-key); start Claude Code with metro claude');
  return true;
}
