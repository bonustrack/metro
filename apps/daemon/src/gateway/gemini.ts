import type { IncomingMessage, ServerResponse } from 'node:http';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';
import { refreshTokens, tokensStale, type GeminiTokens } from './gemini-auth.js';
import { API, clientHeaders, generateBases, machineSessionId, type Bases } from './gemini-client.js';
import { GeminiStreamTranslator } from './gemini-stream.js';
import { toGeminiRequest } from './gemini-translate.js';
import { ToolNames } from './codex-translate.js';
import { assembleMessage, SseParser } from './codex-stream.js';
import { GatewayError, idleMessage, providerStatus, sendError, upstreamMessage, type Watch } from './forward.js';
import type { Connection } from './model-config.js';
import { UsageScanner } from './usage.js';
import { effortToApply, withoutEffort } from './effort.js';

const PING_MS = 25_000;
const STATUS_OF: Record<string, number> = { rate_limit_error: 429, invalid_request_error: 400, permission_error: 403, overloaded_error: 529 };

export interface GeminiDeps {
  base?: Bases;
  tokenBase?: string;
  fetchImpl?: typeof fetch;
  save: (id: string, tokens: GeminiTokens) => void;
}

interface Slot {
  refreshing: Promise<GeminiTokens> | null;
  latest: GeminiTokens | null;
}

export type GeminiState = Map<string, Slot>;

export const sharedGeminiState: GeminiState = new Map();

function slotFor(state: GeminiState, id: string): Slot {
  const found = state.get(id);
  if (found !== undefined) return found;
  const made: Slot = { refreshing: null, latest: null };
  state.set(id, made);
  return made;
}

const newerThan = (a: GeminiTokens, b: GeminiTokens): boolean => Date.parse(a.savedAt) > Date.parse(b.savedAt);

function refreshed(id: string, tokens: GeminiTokens, deps: GeminiDeps, state: GeminiState): Promise<GeminiTokens> {
  const slot = slotFor(state, id);
  const latest = slot.latest;
  if (latest !== null && newerThan(latest, tokens) && !tokensStale(latest)) return Promise.resolve(latest);
  if (slot.refreshing !== null) return slot.refreshing;
  const run = refreshTokens(tokens, deps.tokenBase, deps.fetchImpl)
    .then((fresh) => {
      deps.save(id, fresh);
      slot.latest = fresh;
      return fresh;
    })
    .catch((err: unknown) => {
      throw new GatewayError(403, 'permission_error', `Google sign-in expired (${errMsg(err)}): connect again on the Model page`);
    })
    .finally(() => {
      slot.refreshing = null;
    });
  slot.refreshing = run;
  return run;
}

export function currentGeminiTokens(conn: Connection, deps: GeminiDeps, state: GeminiState): Promise<GeminiTokens> {
  const tokens = conn.gemini;
  if (tokens === null) throw new GatewayError(400, 'invalid_request_error', 'Gemini is not connected: sign in with Google on the Model page.');
  return tokensStale(tokens) ? refreshed(conn.id, tokens, deps, state) : Promise.resolve(tokens);
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
  conn: Connection;
}

const headersFor = (token: string, stream: boolean): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
  ...clientHeaders(),
  'x-machine-session-id': machineSessionId(),
  ...(stream ? { accept: 'text/event-stream' } : {}),
});

async function sendTo(base: string, call: Call, tokens: GeminiTokens, stream: boolean): Promise<Response> {
  const request = toGeminiRequest(call.body, call.model, tokens.project, call.promptId, call.names);
  const method = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
  return (call.deps.fetchImpl ?? fetch)(`${base}/${API}:${method}`, {
    method: 'POST',
    headers: headersFor(tokens.accessToken, stream),
    body: JSON.stringify(request),
    signal: call.watch.signal,
    redirect: 'manual',
  });
}

async function send(call: Call, tokens: GeminiTokens, stream: boolean): Promise<Response> {
  const bases = generateBases(call.deps.base);
  let last: Response | null = null;
  for (const base of bases) {
    if (last !== null) await last.body?.cancel();
    try {
      last = await sendTo(base, call, tokens, stream);
    } catch (err) {
      if (base === bases.at(-1) || call.watch.signal.aborted) throw err;
      continue;
    }
    if (last.status < 500 && last.status !== 429) return last;
  }
  if (last === null) throw new GatewayError(502, 'api_error', 'no Code Assist endpoint to call');
  return last;
}

const REFUSAL_LOG_MAX = 2000;

const detailText = (detail: Record<string, unknown>): string[] => {
  const out: string[] = [];
  if (typeof detail.reason === 'string') out.push(detail.reason);
  if (isRecord(detail.metadata)) out.push(...Object.entries(detail.metadata).map(([k, v]) => `${k}=${String(v)}`));
  if (typeof detail.retryDelay === 'string') out.push(`retry after ${detail.retryDelay}`);
  if (Array.isArray(detail.violations))
    out.push(...detail.violations.filter(isRecord).map((v) => [v.subject, v.description].filter((x) => typeof x === 'string').join(': ')));
  return out.filter((x) => x !== '');
};

export function refusalMessage(text: string, status: number): string {
  const message = upstreamMessage(text, `Gemini answered ${String(status)}`);
  let details: unknown = null;
  try {
    const parsed: unknown = JSON.parse(text);
    details = isRecord(parsed) && isRecord(parsed.error) ? parsed.error.details : null;
  } catch {
    return message;
  }
  const notes = Array.isArray(details) ? details.filter(isRecord).flatMap(detailText) : [];
  return notes.length === 0 ? message : `${message} (${notes.join('; ')})`;
}

async function reach(call: Call, conn: Connection, state: GeminiState, stream: boolean): Promise<Response> {
  let tokens = await currentGeminiTokens(conn, call.deps, state);
  let upstream = await send(call, tokens, stream);
  if (upstream.status === 401) {
    await upstream.body?.cancel();
    tokens = await refreshed(conn.id, tokens, call.deps, state);
    upstream = await send(call, tokens, stream);
  }
  return upstream;
}

export interface GeminiModel {
  id: string;
  name: string;
  remaining: number | null;
  resetAt: string | null;
}

const modelOf = (id: string, raw: unknown): GeminiModel => {
  const entry = isRecord(raw) ? raw : {};
  const quota = isRecord(entry.quotaInfo) ? entry.quotaInfo : null;
  const fraction = quota !== null && typeof quota.remainingFraction === 'number' ? quota.remainingFraction : null;
  const resetAt = quota !== null && typeof quota.resetTime === 'string' ? quota.resetTime : null;
  return { id, name: typeof entry.displayName === 'string' ? entry.displayName : id, remaining: fraction ?? (resetAt === null ? null : 0), resetAt };
};

export async function listGeminiModels(tokens: GeminiTokens, deps: GeminiDeps): Promise<GeminiModel[]> {
  let last = 'no Code Assist endpoint to call';
  for (const base of generateBases(deps.base)) {
    try {
      const res = await (deps.fetchImpl ?? fetch)(`${base}/${API}:fetchAvailableModels`, {
        method: 'POST',
        headers: headersFor(tokens.accessToken, false),
        body: JSON.stringify({ project: tokens.project }),
        signal: AbortSignal.timeout(30_000),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        last = upstreamMessage(JSON.stringify(body), `Google answered ${String(res.status)}`);
        continue;
      }
      const models = isRecord(body) && isRecord(body.models) ? body.models : {};
      return Object.entries(models)
        .filter(([id]) => id.startsWith('gemini'))
        .map(([id, raw]) => modelOf(id, raw));
    } catch (err) {
      last = errMsg(err);
    }
  }
  throw new GatewayError(502, 'api_error', `could not list the Gemini models: ${last}`);
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
  const scanner = new UsageScanner(call.conn.id);
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
  const scanner = new UsageScanner(call.conn.id);
  scanner.feed(frames);
  scanner.done();
  const message = assembleMessage(frames);
  const kind = isRecord(message.error) ? String(message.error.type) : '';
  res.writeHead(message.type === 'error' ? (STATUS_OF[kind] ?? 502) : 200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(message));
}

const NAMES_THINKING = /thinking|thought/i;

function refuse(res: ServerResponse, model: string, status: number, text: string): void {
  log.warn({ provider: 'gemini', model, status, body: text.slice(0, REFUSAL_LOG_MAX) }, 'gateway: the provider refused the request');
  sendError(res, providerStatus(status), errorKind(status), refusalMessage(text, status));
}

export async function geminiMessages(
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown>,
  model: string,
  conn: Connection,
  deps: GeminiDeps,
  state: GeminiState,
  watch: Watch,
): Promise<void> {
  const stream = body.stream === true;
  let call: Call = { body, model, promptId: promptIdOf(req), watch, deps, names: new ToolNames(), conn };
  let upstream = await reach(call, conn, state, stream);
  if (upstream.status === 400 && effortToApply(body) !== null) {
    const text = await upstream.text();
    if (!NAMES_THINKING.test(text)) {
      refuse(res, model, 400, text);
      return;
    }
    log.warn({ provider: 'gemini', model }, 'gateway: Gemini refused the thinking level, so metro asked again without it');
    call = { ...call, body: withoutEffort(body) };
    upstream = await reach(call, conn, state, stream);
  }
  if (!upstream.ok) {
    refuse(res, model, upstream.status, await upstream.text());
    return;
  }
  if (stream) await relayStream(upstream, res, call);
  else await relayWhole(upstream, res, call);
}

export function geminiCount(res: ServerResponse, body: Record<string, unknown>): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ input_tokens: Math.ceil(JSON.stringify(body).length / 4) }));
}
