import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { arch, platform, release } from 'node:os';
import { isRecord } from '../daemon/is-record.js';
import { errMsg, log } from '../daemon/log.js';
import { refreshTokens, tokensStale, type CodexTokens } from './codex-auth.js';
import { assembleMessage, CodexEventTranslator, parseEvent, SseParser } from './codex-stream.js';
import { ToolNames, toResponsesRequest } from './codex-translate.js';
import { GatewayError, idleMessage, providerStatus, sendError, upstreamMessage, type Watch } from './forward.js';
import type { ModelConfig } from './model-config.js';

export const CODEX_BASE = 'https://chatgpt.com/backend-api/codex';
const CODEX_VERSION = '0.153.4';
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/;
const PING_MS = 25_000;
const STATUS_OF: Record<string, number> = { rate_limit_error: 429, invalid_request_error: 400, permission_error: 403, overloaded_error: 529 };

export interface CodexDeps {
  base?: string;
  issuer?: string;
  fetchImpl?: typeof fetch;
  save: (tokens: CodexTokens) => void;
}

export interface CodexState {
  refreshing: Promise<CodexTokens> | null;
  latest: CodexTokens | null;
}

export const freshCodexState = (): CodexState => ({ refreshing: null, latest: null });

const OS_NAMES: Record<string, string> = { darwin: 'Mac OS', linux: 'Linux', win32: 'Windows' };

export function codexVersion(): string {
  const wanted = process.env.METRO_CODEX_VERSION?.trim() ?? '';
  if (wanted === '') return CODEX_VERSION;
  if (VERSION_RE.test(wanted)) return wanted;
  log.warn({ value: wanted }, 'gateway: METRO_CODEX_VERSION is not a version like 0.153.4; using the built-in one');
  return CODEX_VERSION;
}

export const userAgent = (): string => `codex_cli_rs/${codexVersion()} (${OS_NAMES[platform()] ?? platform()} ${release()}; ${arch()}) metro`;

function headersFor(tokens: CodexTokens, sessionId: string): Record<string, string> {
  return {
    authorization: `Bearer ${tokens.accessToken}`,
    'chatgpt-account-id': tokens.accountId,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    originator: 'codex_cli_rs',
    'user-agent': userAgent(),
    'openai-beta': 'responses=experimental',
    'session-id': sessionId,
  };
}

const newerThan = (a: CodexTokens, b: CodexTokens): boolean => Date.parse(a.savedAt) > Date.parse(b.savedAt);

function refreshed(tokens: CodexTokens, deps: CodexDeps, state: CodexState): Promise<CodexTokens> {
  const latest = state.latest;
  if (latest !== null && newerThan(latest, tokens) && !tokensStale(latest)) return Promise.resolve(latest);
  if (state.refreshing !== null) return state.refreshing;
  const run = refreshTokens(tokens, deps.issuer, deps.fetchImpl)
    .then((fresh) => {
      deps.save(fresh);
      state.latest = fresh;
      return fresh;
    })
    .catch((err: unknown) => {
      throw new GatewayError(403, 'permission_error', `Codex sign-in expired (${errMsg(err)}): connect again on the Model page`);
    })
    .finally(() => {
      state.refreshing = null;
    });
  state.refreshing = run;
  return run;
}

export function currentTokens(cfg: ModelConfig, deps: CodexDeps, state: CodexState): Promise<CodexTokens> {
  const tokens = cfg.codex.auth;
  if (tokens === null) throw new GatewayError(400, 'invalid_request_error', 'Codex is not connected: sign in on the Model page.');
  return tokensStale(tokens) ? refreshed(tokens, deps, state) : Promise.resolve(tokens);
}

function errorKind(status: number): string {
  if (status === 401 || status === 403) return 'permission_error';
  if (status === 429) return 'rate_limit_error';
  if (status === 400 || status === 404 || status === 422) return 'invalid_request_error';
  return 'api_error';
}

const sessionIdOf = (req: IncomingMessage): string => {
  const raw = req.headers['x-claude-code-session-id'];
  const given = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
  return given === '' ? randomUUID() : given;
};

interface Call {
  body: Record<string, unknown>;
  model: string;
  sessionId: string;
  watch: Watch;
  deps: CodexDeps;
  names: ToolNames;
}

function send(call: Call, tokens: CodexTokens): Promise<Response> {
  const request = toResponsesRequest(call.body, call.model, { promptCacheKey: call.sessionId, names: call.names });
  return (call.deps.fetchImpl ?? fetch)(`${call.deps.base ?? CODEX_BASE}/responses`, {
    method: 'POST',
    headers: headersFor(tokens, call.sessionId),
    body: JSON.stringify(request),
    signal: call.watch.signal,
    redirect: 'manual',
  });
}

async function reach(call: Call, cfg: ModelConfig, state: CodexState): Promise<Response> {
  let tokens = await currentTokens(cfg, call.deps, state);
  let upstream = await send(call, tokens);
  if (upstream.status === 401) {
    await upstream.body?.cancel();
    tokens = await refreshed(tokens, call.deps, state);
    upstream = await send(call, tokens);
  }
  return upstream;
}

async function relayStream(upstream: Response, res: ServerResponse, model: string, names: ToolNames, watch: Watch): Promise<void> {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  const translator = new CodexEventTranslator(model, (name) => names.restore(name));
  const body = upstream.body;
  if (body === null) {
    res.end(translator.close());
    return;
  }
  const ping = setInterval(() => res.write('event: ping\ndata: {"type":"ping"}\n\n'), PING_MS);
  try {
    const parser = new SseParser();
    const decoder = new TextDecoder();
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      watch.touch();
      for (const raw of parser.push(decoder.decode(value, { stream: true }))) {
        const parsed = parseEvent(raw);
        if (parsed !== null) res.write(translator.push(parsed.event, parsed.data));
      }
    }
    res.write(translator.close());
  } catch (err) {
    if (!watch.idle()) throw err;
    res.write(translator.finished ? '' : translator.close(idleMessage(watch.ms)));
  } finally {
    clearInterval(ping);
    watch.stop();
    res.end();
  }
}

async function relayWhole(upstream: Response, res: ServerResponse, model: string, names: ToolNames): Promise<void> {
  const translator = new CodexEventTranslator(model, (name) => names.restore(name));
  let frames = '';
  const parser = new SseParser();
  for (const raw of parser.push(await upstream.text())) {
    const parsed = parseEvent(raw);
    if (parsed !== null) frames += translator.push(parsed.event, parsed.data);
  }
  frames += translator.close();
  const message = assembleMessage(frames);
  const kind = isRecord(message.error) ? String(message.error.type) : '';
  res.writeHead(message.type === 'error' ? (STATUS_OF[kind] ?? 502) : 200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(message));
}

export async function codexMessages(
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown>,
  model: string,
  cfg: ModelConfig,
  deps: CodexDeps,
  state: CodexState,
  watch: Watch,
): Promise<void> {
  const call: Call = { body, model, sessionId: sessionIdOf(req), watch, deps, names: new ToolNames() };
  const upstream = await reach(call, cfg, state);
  if (!upstream.ok) {
    const text = await upstream.text();
    sendError(res, providerStatus(upstream.status), errorKind(upstream.status), upstreamMessage(text, `Codex answered ${String(upstream.status)}`));
    return;
  }
  if (body.stream === true) await relayStream(upstream, res, model, call.names, watch);
  else await relayWhole(upstream, res, model, call.names);
}

export function codexCount(res: ServerResponse, body: Record<string, unknown>): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ input_tokens: Math.ceil(JSON.stringify(body).length / 4) }));
}

export async function codexModels(tokens: CodexTokens, deps: Omit<CodexDeps, 'save'>): Promise<string[]> {
  const res = await (deps.fetchImpl ?? fetch)(`${deps.base ?? CODEX_BASE}/models?client_version=${codexVersion()}`, {
    headers: { ...headersFor(tokens, randomUUID()), accept: 'application/json' },
    redirect: 'manual',
  });
  if (!res.ok) throw new GatewayError(res.status, errorKind(res.status), `Codex would not list models (${String(res.status)})`);
  const slugs = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === 'object' && value !== null) {
      const record = value as Record<string, unknown>;
      if (typeof record.slug === 'string' && record.slug !== '') slugs.add(record.slug);
      Object.values(record).forEach(walk);
    }
  };
  walk(await res.json());
  return [...slugs];
}
