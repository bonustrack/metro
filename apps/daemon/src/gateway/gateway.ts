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
import { anthropicHeaders, forwardedHeaders, GatewayError, parseJson, pipeResponse, readBody, sendError, watchUpstream } from './forward.js';
import { notReady, readModelConfig, resolveRoute, routeLabel, setCodexAuth, writeModelConfig, type ModelConfig, type Route } from './model-config.js';
import { codexCount, codexMessages, freshCodexState, type CodexDeps } from './codex.js';
import { OPENROUTER_BASE } from './openrouter.js';
import { forgetServed, noteServed } from './served.js';
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
}

const learned: Adaptations = freshAdaptations();
const codexState = freshCodexState();

export function resetGatewayState(): void {
  forgetServed();
  learned.fields.clear();
  learned.dropBetas = false;
  Object.assign(codexState, freshCodexState());
}

const saveCodexTokens = (tokens: CodexTokens): void => {
  writeModelConfig(setCodexAuth(readModelConfig(), tokens));
};

const keyOf = (req: IncomingMessage): string => {
  const raw = req.headers['x-metro-key'];
  return (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
};

const defaultIdentify = (key: string): boolean => key !== '' && agentIdForKey(key) !== undefined;

function modelsBody(cfg: ModelConfig): Record<string, unknown> {
  const data: Record<string, string>[] = [];
  if (cfg.bedrock.model !== '')
    data.push({ id: `bedrock:${cfg.bedrock.model}`, display_name: `Bedrock · ${cfg.bedrock.model}`, description: 'Through metro, billed to Amazon Bedrock' });
  if (cfg.openrouter.model !== '')
    data.push({ id: `openrouter:${cfg.openrouter.model}`, display_name: `OpenRouter · ${cfg.openrouter.model}`, description: 'Through metro, billed to OpenRouter' });
  if (cfg.codex.model !== '')
    data.push({ id: `codex:${cfg.codex.model}`, display_name: `Codex · ${cfg.codex.model}`, description: 'Through metro, on your ChatGPT subscription' });
  return { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null };
}

function requestedModel(body: Record<string, unknown>): string {
  const model = body.model;
  if (typeof model !== 'string' || model === '') throw new GatewayError(400, 'invalid_request_error', 'model is required');
  return model;
}

const standsInFor = (req: IncomingMessage): boolean => {
  const metroKey = req.headers['x-metro-key'];
  return typeof metroKey === 'string' && metroKey !== '' && req.headers.authorization === `Bearer ${metroKey}`;
};

async function toAnthropic(
  req: IncomingMessage,
  res: ServerResponse,
  raw: Buffer,
  body: Record<string, unknown>,
  route: Route,
  deps: GatewayDeps,
): Promise<void> {
  const explicit = typeof body.model === 'string' && body.model !== route.model;
  const payload = explicit ? Buffer.from(JSON.stringify({ ...body, model: route.model })) : raw;
  const url = `${deps.anthropicBase ?? ANTHROPIC_BASE}${(req.url ?? '').slice(GATEWAY_PREFIX.length)}`;
  const key = deps.config().anthropic.apiKey;
  if (key === '' && standsInFor(req))
    throw new GatewayError(
      403,
      'permission_error',
      'Claude Code on this machine has no Anthropic login of its own; choose Bedrock, OpenRouter or Codex on the Model page, or sign in on the Claude tab',
    );
  const watch = watchUpstream(res);
  const upstream = await fetch(url, {
    method: 'POST',
    headers: key === '' ? forwardedHeaders(req) : anthropicHeaders(req, key),
    body: new Uint8Array(payload),
    signal: watch.signal,
    redirect: 'manual',
  });
  await pipeResponse(upstream, res, watch, key === '' ? {} : { ownCredential: true });
}

async function toOpenRouter(
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown>,
  route: Route,
  cfg: ModelConfig,
  deps: GatewayDeps,
): Promise<void> {
  const reason = notReady(cfg, 'openrouter');
  if (reason !== null) throw new GatewayError(400, 'invalid_request_error', reason);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: req.headers.accept ?? 'application/json',
    authorization: `Bearer ${cfg.openrouter.apiKey}`,
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
    body: JSON.stringify({ ...body, model: route.model }),
    signal: watch.signal,
    redirect: 'manual',
  });
  await pipeResponse(upstream, res, watch, { keepalive: true, ownCredential: true });
}

async function dispatch(req: IncomingMessage, res: ServerResponse, path: string, deps: GatewayDeps): Promise<void> {
  const cfg = deps.config();
  const raw = await readBody(req);
  const body = parseJson(raw);
  const route = resolveRoute(requestedModel(body), cfg);
  log.info({ route: routeLabel(route), path }, 'gateway: routing');
  if (path === MESSAGES) noteServed({ provider: route.provider, model: route.model, at: new Date().toISOString() });
  if (route.provider === 'bedrock') {
    assertBedrockReady(cfg.bedrock);
    const up = { settings: cfg.bedrock, base: deps.bedrockBase ?? bedrockBase(cfg.bedrock.region), learned, watch: watchUpstream(res) };
    if (path === COUNT) await bedrockCount(req, res, body, route.model, up);
    else await bedrockMessages(req, res, body, route.model, up);
    return;
  }
  if (route.provider === 'openrouter') {
    if (path === COUNT) throw new GatewayError(404, 'not_found_error', 'OpenRouter does not count tokens');
    await toOpenRouter(req, res, body, route, cfg, deps);
    return;
  }
  if (route.provider === 'codex') {
    if (path === COUNT) {
      codexCount(res, body);
      return;
    }
    const codexDeps: CodexDeps = { save: saveCodexTokens, ...deps.codex };
    await codexMessages(req, res, body, route.model, cfg, codexDeps, codexState, watchUpstream(res));
    return;
  }
  await toAnthropic(req, res, raw, body, route, deps);
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
