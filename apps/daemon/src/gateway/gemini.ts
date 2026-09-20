import type { IncomingMessage, ServerResponse } from 'node:http';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg } from '@metro-labs/core/log';
import { refreshTokens, tokensStale, type GeminiTokens } from './gemini-auth.js';
import { CODE_ASSIST_BASE, userAgent } from './gemini-setup.js';
import { GeminiStreamTranslator } from './gemini-stream.js';
import { toGeminiRequest } from './gemini-translate.js';
import { ToolNames } from './codex-translate.js';
import { assembleMessage, SseParser } from './codex-stream.js';
import { GatewayError, idleMessage, providerStatus, sendError, upstreamMessage, type Watch } from './forward.js';
import type { ModelConfig } from './model-config.js';
import { UsageScanner } from './usage.js';

const PING_MS = 25_000;
const STATUS_OF: Record<string, number> = { rate_limit_error: 429, invalid_request_error: 400, permission_error: 403, overloaded_error: 529 };

export const KNOWN_GEMINI_MODELS = ['gemini-3.1-pro-preview', 'gemini-3-pro-preview', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite', 'gemini-2.5-pro', 'gemini-2.5-flash'];

export interface GeminiDeps {
  base?: string;
  tokenBase?: string;
  fetchImpl?: typeof fetch;
  save: (tokens: GeminiTokens) => void;
}

export interface GeminiState {
  refreshing: Promise<GeminiTokens> | null;
  latest: GeminiTokens | null;
}

export const freshGeminiState = (): GeminiState => ({ refreshing: null, latest: null });

const newerThan = (a: GeminiTokens, b: GeminiTokens): boolean => Date.parse(a.savedAt) > Date.parse(b.savedAt);

function refreshed(tokens: GeminiTokens, deps: GeminiDeps, state: GeminiState): Promise<GeminiTokens> {
  const latest = state.latest;
  if (latest !== null && newerThan(latest, tokens) && !tokensStale(latest)) return Promise.resolve(latest);
  if (state.refreshing !== null) return state.refreshing;
  const run = refreshTokens(tokens, deps.tokenBase, deps.fetchImpl)
    .then((fresh) => {
      deps.save(fresh);
      state.latest = fresh;
      return fresh;
    })
    .catch((err: unknown) => {
      throw new GatewayError(403, 'permission_error', `Google sign-in expired (${errMsg(err)}): connect again on the Model page`);
    })
    .finally(() => {
      state.refreshing = null;
    });
  state.refreshing = run;
  return run;
}

export function currentGeminiTokens(cfg: ModelConfig, deps: GeminiDeps, state: GeminiState): Promise<GeminiTokens> {
  const tokens = cfg.gemini.auth;
  if (tokens === null) throw new GatewayError(400, 'invalid_request_error', 'Gemini is not connected: sign in with Google on the Model page.');
  return tokensStale(tokens) ? refreshed(tokens, deps, state) : Promise.resolve(tokens);
}

function errorKind(status: number): string {
  if (status === 401 || status === 403) return 'permission_error';
  if (status === 429) return 'rate_limit_error';
  if (status === 400 || status === 404) return 'invalid_request_error';
  return 'api_error';
}

const promptIdOf = (req: IncomingMessage): string => {
  const raw = req.headers['x-claude-code-session-id'];
  const given = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
  return given === '' ? 'metro' : given;
};

interface Call {
  body: Record<string, unknown>;
  model: string;
  promptId: string;
  watch: Watch;
  deps: GeminiDeps;
  names: ToolNames;
}

function send(call: Call, tokens: GeminiTokens, stream: boolean): Promise<Response> {
  const request = toGeminiRequest(call.body, call.model, tokens.project, call.promptId, call.names);
  const method = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
  return (call.deps.fetchImpl ?? fetch)(`${call.deps.base ?? CODE_ASSIST_BASE}/v1internal:${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokens.accessToken}`, 'content-type': 'application/json', 'user-agent': userAgent(call.model) },
    body: JSON.stringify(request),
    signal: call.watch.signal,
    redirect: 'manual',
  });
}

async function reach(call: Call, cfg: ModelConfig, state: GeminiState, stream: boolean): Promise<Response> {
  let tokens = await currentGeminiTokens(cfg, call.deps, state);
  let upstream = await send(call, tokens, stream);
  if (upstream.status === 401) {
    await upstream.body?.cancel();
    tokens = await refreshed(tokens, call.deps, state);
    upstream = await send(call, tokens, stream);
  }
  return upstream;
}

const parseData = (raw: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

async function relayStream(upstream: Response, res: ServerResponse, call: Call): Promise<void> {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  const translator = new GeminiStreamTranslator(call.model, (name) => call.names.restore(name));
  const body = upstream.body;
  if (body === null) {
    res.end(translator.close());
    return;
  }
  const ping = setInterval(() => res.write('event: ping\ndata: {"type":"ping"}\n\n'), PING_MS);
  const scanner = new UsageScanner('gemini');
  const emit = (frames: string): void => {
    if (frames === '') return;
    scanner.feed(frames);
    res.write(frames);
  };
  try {
    const parser = new SseParser();
    const decoder = new TextDecoder();
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      call.watch.touch();
      for (const raw of parser.push(decoder.decode(value, { stream: true }))) {
        const data = parseData(raw.data);
        if (data !== null) emit(translator.push(data));
      }
    }
    emit(translator.close());
  } catch (err) {
    if (!call.watch.idle()) throw err;
    res.write(translator.finished ? '' : translator.close(idleMessage(call.watch.ms)));
  } finally {
    clearInterval(ping);
    call.watch.stop();
    res.end();
    scanner.done();
  }
}

async function relayWhole(upstream: Response, res: ServerResponse, call: Call): Promise<void> {
  const translator = new GeminiStreamTranslator(call.model, (name) => call.names.restore(name));
  const data = parseData(await upstream.text());
  const frames = (data === null ? '' : translator.push(data)) + translator.close();
  const scanner = new UsageScanner('gemini');
  scanner.feed(frames);
  scanner.done();
  const message = assembleMessage(frames);
  const kind = isRecord(message.error) ? String(message.error.type) : '';
  res.writeHead(message.type === 'error' ? (STATUS_OF[kind] ?? 502) : 200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(message));
}

export async function geminiMessages(
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown>,
  model: string,
  cfg: ModelConfig,
  deps: GeminiDeps,
  state: GeminiState,
  watch: Watch,
): Promise<void> {
  const stream = body.stream === true;
  const call: Call = { body, model, promptId: promptIdOf(req), watch, deps, names: new ToolNames() };
  const upstream = await reach(call, cfg, state, stream);
  if (!upstream.ok) {
    const text = await upstream.text();
    sendError(res, providerStatus(upstream.status), errorKind(upstream.status), upstreamMessage(text, `Gemini answered ${String(upstream.status)}`));
    return;
  }
  if (stream) await relayStream(upstream, res, call);
  else await relayWhole(upstream, res, call);
}

export function geminiCount(res: ServerResponse, body: Record<string, unknown>): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ input_tokens: Math.ceil(JSON.stringify(body).length / 4) }));
}
