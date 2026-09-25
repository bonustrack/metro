import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { arch, platform, release } from 'node:os';
import { log } from '@metro-labs/core/log';
import { refreshTokens, tokensStale, type CodexTokens } from './codex-auth.js';
import { CodexEventTranslator } from './codex-stream.js';
import { ToolNames, toResponsesRequest } from './codex-translate.js';
import { GatewayError, providerStatus, sendError, upstreamMessage, type Watch } from './forward.js';
import { parseEvent, SseParser, type SseEvent } from './frames.js';
import type { Connection } from './model-config.js';
import { answerWhole, currentOf, errorKind, reach, refreshed, relayTranslated, sessionHeader, type TokenSource, type TokenState } from './subscription.js';
import { noteUsageHeaders } from './usage.js';

const CODEX_BASE = 'https://chatgpt.com/backend-api/codex';
const CODEX_VERSION = '0.153.4';
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/;
const INVALID = [400, 404, 422];

export interface CodexDeps {
  base?: string;
  issuer?: string;
  fetchImpl?: typeof fetch;
  save: (id: string, tokens: CodexTokens) => void;
}

export type CodexState = TokenState<CodexTokens>;

export const sharedCodexState: CodexState = new Map();

const sourceOf = (deps: CodexDeps): TokenSource<CodexTokens> => ({
  label: 'Codex',
  stale: (tokens) => tokensStale(tokens),
  refresh: (tokens) => refreshTokens(tokens, deps.issuer, deps.fetchImpl),
  save: deps.save,
});

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

export const currentTokens = (conn: Connection, deps: CodexDeps, state: CodexState): Promise<CodexTokens> =>
  currentOf(state, conn.id, conn.codex, sourceOf(deps), 'Codex is not connected: sign in on the Model page.');

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

export async function codexMessages(
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown>,
  model: string,
  conn: Connection,
  deps: CodexDeps,
  state: CodexState,
  watch: Watch,
): Promise<void> {
  const call: Call = { body, model, sessionId: sessionHeader(req) || randomUUID(), watch, deps, names: new ToolNames() };
  const upstream = await reach(
    () => currentTokens(conn, deps, state),
    (tokens) => refreshed(state, conn.id, tokens, sourceOf(deps)),
    (tokens) => send(call, tokens),
  );
  noteUsageHeaders('codex', conn.id, upstream.headers);
  if (!upstream.ok) {
    const text = await upstream.text();
    sendError(res, providerStatus(upstream.status), errorKind(upstream.status, INVALID), upstreamMessage(text, `Codex answered ${String(upstream.status)}`));
    return;
  }
  const translator = new CodexEventTranslator(model, (name) => call.names.restore(name));
  const onEvent = (raw: SseEvent): string => {
    const parsed = parseEvent(raw);
    return parsed === null ? '' : translator.push(parsed.event, parsed.data);
  };
  if (body.stream === true) {
    await relayTranslated(upstream, res, watch, conn.id, translator, onEvent);
    return;
  }
  const frames = new SseParser().push(await upstream.text()).map(onEvent).join('');
  answerWhole(res, frames + translator.close(), conn.id);
}

export async function codexModels(tokens: CodexTokens, deps: Omit<CodexDeps, 'save'>): Promise<string[]> {
  const res = await (deps.fetchImpl ?? fetch)(`${deps.base ?? CODEX_BASE}/models?client_version=${codexVersion()}`, {
    headers: { ...headersFor(tokens, randomUUID()), accept: 'application/json' },
    redirect: 'manual',
  });
  if (!res.ok) throw new GatewayError(res.status, errorKind(res.status, INVALID), `Codex would not list models (${String(res.status)})`);
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
