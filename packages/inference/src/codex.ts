import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { arch, platform, release } from 'node:os';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';
import { stringOf } from '@metro-labs/http/api-http';
import { codexVersion, learnCodexVersion } from './codex-version.js';
import { CodexEventTranslator, withUsageLink } from './codex-stream.js';
import { ToolNames, toResponsesRequest } from './codex-translate.js';
import { agentIdOf } from './effort.js';
import { noteFailure, type Failure, type FailureSite } from './failures.js';
import { GatewayError, providerStatus, sendError, upstreamMessage, type Watch } from './forward.js';
import { parseEvent, SseParser, type SseEvent } from './frames.js';
import { CODEX_SIGN_IN, type CodexAccess, type Connection } from './model-config.js';
import { answerWhole, errorKind, relayTranslated, sessionHeader } from './subscription.js';
import { noteUsageHeaders } from './usage.js';

const CODEX_BACKEND = 'https://chatgpt.com/backend-api/codex';
const OPENAI_API = 'https://api.openai.com/v1';
const INVALID = [400, 404, 422];
const RENEW_FAILED = "Codex refused its sign-in and api.metro.box could not renew it: sign in again on the organization's Gateway page.";

export interface CodexDeps {
  base?: string;
  fetchImpl?: typeof fetch;
  refresh: (conn: Connection) => Promise<Connection | null>;
  caller?: string;
}

const OS_NAMES: Record<string, string> = { darwin: 'Mac OS', linux: 'Linux', win32: 'Windows' };

export const userAgent = (): string => `codex_cli_rs/${codexVersion()} (${OS_NAMES[platform()] ?? platform()} ${release()}; ${arch()}) metro`;

const baseFor = (access: CodexAccess, deps: Pick<CodexDeps, 'base'>): string => deps.base ?? (access.method === 'code' ? CODEX_BACKEND : OPENAI_API);

function headersFor(access: CodexAccess, sessionId: string): Record<string, string> {
  const plain = { authorization: `Bearer ${access.accessToken}`, 'content-type': 'application/json', accept: 'text/event-stream' };
  if (access.method === 'chatgpt') return plain;
  return {
    ...plain,
    'chatgpt-account-id': access.accountId ?? '',
    originator: 'codex_cli_rs',
    'user-agent': userAgent(),
    'openai-beta': 'responses=experimental',
    'session-id': sessionId,
  };
}

interface Call {
  body: Record<string, unknown>;
  model: string;
  unaskedEffort: string | null;
  threadKey: string;
  watch: Watch;
  deps: CodexDeps;
  names: ToolNames;
}

const CALLER_THREAD = 'metro-codex-caller-thread/v1';

const digest = (text: string): string => createHash('sha256').update(text).digest('base64url');

function sessionOf(req: IncomingMessage, caller: string, model: string): string {
  const header = sessionHeader(req);
  if (header !== '') return header;
  return caller === '' ? randomUUID() : digest(`${CALLER_THREAD}\n${caller}\n${model}`);
}

function threadKey(req: IncomingMessage, caller: string, model: string): string {
  const session = sessionOf(req, caller, model);
  const agent = agentIdOf(req);
  return agent === '' ? session : digest(`${session}\n${agent}`);
}

export const CACHE_OPTIONS = { mode: 'implicit', ttl: '12h' } as const;
const CACHE_FIELD = 'prompt_cache_options';
const cacheRefused = new Set<string>();

export function forgetCacheRefusals(): void {
  cacheRefused.clear();
}

function send(call: Call, access: CodexAccess, cacheOptions: boolean): Promise<Response> {
  const translated = toResponsesRequest(call.body, call.model, { promptCacheKey: call.threadKey, names: call.names, unaskedEffort: call.unaskedEffort });
  const request = cacheOptions ? { ...translated, [CACHE_FIELD]: CACHE_OPTIONS } : translated;
  return (call.deps.fetchImpl ?? fetch)(`${baseFor(access, call.deps)}/responses`, {
    method: 'POST',
    headers: headersFor(access, call.threadKey),
    body: JSON.stringify(request),
    signal: call.watch.signal,
    redirect: 'manual',
  });
}

async function sendWithCache(call: Call, conn: Connection, access: CodexAccess): Promise<Response> {
  const cacheOptions = access.method === 'chatgpt' && !cacheRefused.has(conn.id);
  const upstream = await send(call, access, cacheOptions);
  if (!cacheOptions || upstream.status !== 400) return upstream;
  const text = await upstream.text();
  if (!text.includes(CACHE_FIELD)) return new Response(text, { status: upstream.status, headers: upstream.headers });
  cacheRefused.add(conn.id);
  log.warn({ connection: conn.label, message: upstreamMessage(text, 'OpenAI answered 400') }, `gateway: OpenAI refused ${CACHE_FIELD} on this connection; its requests go without it`);
  return send(call, access, false);
}

function refusalOf(text: string, status: number): Failure {
  let code = '';
  try {
    const parsed: unknown = JSON.parse(text);
    code = isRecord(parsed) && isRecord(parsed.error) ? stringOf(parsed.error.code) : '';
  } catch {
    code = '';
  }
  return { code, message: upstreamMessage(text, `OpenAI answered ${String(status)}`), status };
}

let learning: Promise<unknown> | null = null;

function learnVersion(access: CodexAccess): void {
  if (access.method !== 'code' || learning !== null) return;
  learning = learnCodexVersion()
    .catch((err: unknown) => {
      log.warn({ err: errMsg(err) }, 'gateway: the latest Codex version could not be learned');
    })
    .finally(() => {
      learning = null;
    });
}

async function reach(call: Call, conn: Connection): Promise<Response> {
  if (conn.codex === null) throw new GatewayError(400, 'invalid_request_error', CODEX_SIGN_IN);
  learnVersion(conn.codex);
  const upstream = await sendWithCache(call, conn, conn.codex);
  if (upstream.status !== 401) return upstream;
  await upstream.body?.cancel();
  const fresh = await call.deps.refresh(conn);
  if (fresh?.codex === null || fresh?.codex === undefined) throw new GatewayError(403, 'permission_error', RENEW_FAILED);
  return sendWithCache(call, fresh, fresh.codex);
}

type CodexAsk = Pick<Call, 'body' | 'model' | 'unaskedEffort'>;

export async function codexMessages(req: IncomingMessage, res: ServerResponse, ask: CodexAsk, conn: Connection, deps: CodexDeps, watch: Watch): Promise<void> {
  const { body, model } = ask;
  const call: Call = { ...ask, threadKey: threadKey(req, deps.caller ?? '', stringOf(body.model)), watch, deps, names: new ToolNames() };
  const site: FailureSite = { connection: conn.label, model };
  const upstream = await reach(call, conn);
  noteUsageHeaders('codex', conn.id, upstream.headers);
  if (!upstream.ok) {
    const refusal = refusalOf(await upstream.text(), upstream.status);
    noteFailure(site, refusal, 'gateway: Codex refused the request');
    sendError(res, providerStatus(upstream.status), errorKind(upstream.status, INVALID), withUsageLink(refusal.code, refusal.message));
    return;
  }
  const translator = new CodexEventTranslator(
    model,
    (name) => call.names.restore(name),
    (failure) => {
      noteFailure(site, failure, 'gateway: Codex did not complete the response');
    },
  );
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
