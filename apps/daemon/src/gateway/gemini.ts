import type { IncomingMessage, ServerResponse } from 'node:http';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';
import { refreshTokens, tokensStale, type GeminiTokens } from './gemini-auth.js';
import { API, clientHeaders, generateBases, machineSessionId, type Bases } from './gemini-client.js';
import { GeminiStreamTranslator } from './gemini-stream.js';
import { toGeminiRequest } from './gemini-translate.js';
import { ToolNames } from './codex-translate.js';
import { GatewayError, providerStatus, sendError, upstreamMessage, type Watch } from './forward.js';
import type { Connection } from './model-config.js';
import { answerWhole, currentOf, errorKind, reach, refreshed, relayTranslated, sessionHeader, type TokenSource, type TokenState } from './subscription.js';
import { effortToApply, withoutEffort } from './effort.js';

export interface GeminiDeps {
  base?: Bases;
  tokenBase?: string;
  fetchImpl?: typeof fetch;
  save: (id: string, tokens: GeminiTokens) => void;
}

export type GeminiState = TokenState<GeminiTokens>;

export const sharedGeminiState: GeminiState = new Map();

const sourceOf = (deps: GeminiDeps): TokenSource<GeminiTokens> => ({
  label: 'Google',
  stale: (tokens) => tokensStale(tokens),
  refresh: (tokens) => refreshTokens(tokens, deps.tokenBase, deps.fetchImpl),
  save: deps.save,
});

export const currentGeminiTokens = (conn: Connection, deps: GeminiDeps, state: GeminiState): Promise<GeminiTokens> =>
  currentOf(state, conn.id, conn.gemini, sourceOf(deps), 'Gemini is not connected: sign in with Google on the Model page.');

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

const reachWith = (call: Call, state: GeminiState, stream: boolean): Promise<Response> =>
  reach(
    () => currentGeminiTokens(call.conn, call.deps, state),
    (tokens) => refreshed(state, call.conn.id, tokens, sourceOf(call.deps)),
    (tokens) => send(call, tokens, stream),
  );

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
  let call: Call = { body, model, promptId: sessionHeader(req) || 'metro', watch, deps, names: new ToolNames(), conn };
  let upstream = await reachWith(call, state, stream);
  if (upstream.status === 400 && effortToApply(body) !== null) {
    const text = await upstream.text();
    if (!NAMES_THINKING.test(text)) {
      refuse(res, model, 400, text);
      return;
    }
    log.warn({ provider: 'gemini', model }, 'gateway: Gemini refused the thinking level, so metro asked again without it');
    call = { ...call, body: withoutEffort(body) };
    upstream = await reachWith(call, state, stream);
  }
  if (!upstream.ok) {
    refuse(res, model, upstream.status, await upstream.text());
    return;
  }
  const translator = new GeminiStreamTranslator(model, (name) => call.names.restore(name));
  if (stream) {
    await relayTranslated(upstream, res, watch, conn.id, translator, (raw) => {
      const data = parseData(raw.data);
      return data === null ? '' : translator.push(data);
    });
    return;
  }
  const data = parseData(await upstream.text());
  answerWhole(res, (data === null ? '' : translator.push(data)) + translator.close(), conn.id);
}
