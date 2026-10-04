import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { arch, platform, release } from 'node:os';
import { isRecord } from '@metro-labs/core/is-record';
import { stringOf } from '@metro-labs/http/api-http';
import { OPENAI_API, CODEX_SIGN_IN, refreshTokens, tokensStale, type CodexTokens } from './codex-auth.js';
import { refreshCodeTokens } from './codex-device.js';
import { codexVersion, learnCodexVersion } from './codex-version.js';
import { CodexEventTranslator, withUsageLink } from './codex-stream.js';
import { ToolNames, toResponsesRequest } from './codex-translate.js';
import { GatewayError, providerStatus, sendError, upstreamMessage, type Watch } from './forward.js';
import { parseEvent, SseParser, type SseEvent } from './frames.js';
import type { Connection } from './model-config.js';
import { listCache } from './model-lists.js';
import { answerWhole, currentOf, errorKind, reach, refreshed, relayTranslated, sessionHeader, type TokenSource, type TokenState } from './subscription.js';
import { noteUsageHeaders } from './usage.js';

const CODEX_BACKEND = 'https://chatgpt.com/backend-api/codex';
const INVALID = [400, 404, 422];

export interface CodexDeps {
  base?: string;
  issuer?: string;
  fetchImpl?: typeof fetch;
  save: (id: string, tokens: CodexTokens) => void;
}

export type CodexState = TokenState<CodexTokens>;

export const sharedCodexState: CodexState = new Map();

const codexLists = listCache<string>('codex');

const sourceOf = (deps: CodexDeps): TokenSource<CodexTokens> => ({
  label: 'Codex',
  stale: (tokens) => tokensStale(tokens),
  refresh: (tokens) => (tokens.method === 'code' ? refreshCodeTokens(tokens, deps.issuer, deps.fetchImpl) : refreshTokens(tokens, deps.issuer, deps.fetchImpl)),
  save: deps.save,
});

const OS_NAMES: Record<string, string> = { darwin: 'Mac OS', linux: 'Linux', win32: 'Windows' };

export const userAgent = (): string => `codex_cli_rs/${codexVersion()} (${OS_NAMES[platform()] ?? platform()} ${release()}; ${arch()}) metro`;

const baseFor = (tokens: CodexTokens, deps: Pick<CodexDeps, 'base'>): string => deps.base ?? (tokens.method === 'code' ? CODEX_BACKEND : OPENAI_API);

function headersFor(tokens: CodexTokens, accept: string, sessionId: string): Record<string, string> {
  const plain = { authorization: `Bearer ${tokens.accessToken}`, 'content-type': 'application/json', accept };
  if (tokens.method === 'chatgpt') return plain;
  return {
    ...plain,
    'chatgpt-account-id': tokens.accountId,
    originator: 'codex_cli_rs',
    'user-agent': userAgent(),
    'openai-beta': 'responses=experimental',
    'session-id': sessionId,
  };
}

export const currentTokens = (conn: Connection, deps: CodexDeps, state: CodexState): Promise<CodexTokens> =>
  currentOf(state, conn.id, conn.codex, sourceOf(deps), CODEX_SIGN_IN);

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
  return (call.deps.fetchImpl ?? fetch)(`${baseFor(tokens, call.deps)}/responses`, {
    method: 'POST',
    headers: headersFor(tokens, 'text/event-stream', call.sessionId),
    body: JSON.stringify(request),
    signal: call.watch.signal,
    redirect: 'manual',
  });
}

function refusalOf(text: string, status: number): string {
  let code = '';
  try {
    const parsed: unknown = JSON.parse(text);
    code = isRecord(parsed) && isRecord(parsed.error) ? stringOf(parsed.error.code) : '';
  } catch {
    code = '';
  }
  return withUsageLink(code, upstreamMessage(text, `OpenAI answered ${String(status)}`));
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
    sendError(res, providerStatus(upstream.status), errorKind(upstream.status, INVALID), refusalOf(text, upstream.status));
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
  const base = baseFor(tokens, deps);
  const fetchImpl = deps.fetchImpl ?? fetch;
  if (tokens.method === 'chatgpt') return codexLists.get(`${base}:${tokens.clientId}`, () => listCodex(tokens, `${base}/models`, fetchImpl));
  const version = await learnCodexVersion();
  return codexLists.get(`${base}:${tokens.accountId}:${version}`, () => listCodex(tokens, `${base}/models?client_version=${version}`, fetchImpl));
}

async function listCodex(tokens: CodexTokens, url: string, fetchImpl: typeof fetch): Promise<string[]> {
  const res = await fetchImpl(url, { headers: headersFor(tokens, 'application/json', randomUUID()), redirect: 'manual' });
  if (!res.ok) throw new GatewayError(res.status, errorKind(res.status, INVALID), `OpenAI would not list the models of this ChatGPT plan (${String(res.status)})`);
  const body: unknown = await res.json();
  const models: unknown[] = isRecord(body) && Array.isArray(body.models) ? body.models : [];
  return models.filter(isRecord).flatMap((m) => ((m.visibility ?? 'list') === 'list' && stringOf(m.slug) !== '' ? [stringOf(m.slug)] : []));
}
