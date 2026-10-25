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
const RENEW_FAILED = "Codex refused its sign-in and api.metro.box could not renew it: sign in again on the organization's Models page.";

export interface CodexDeps {
  base?: string;
  fetchImpl?: typeof fetch;
  refresh: (conn: Connection) => Promise<Connection | null>;
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
  threadKey: string;
  watch: Watch;
  deps: CodexDeps;
  names: ToolNames;
}

function threadKey(req: IncomingMessage): string {
  const session = sessionHeader(req) || randomUUID();
  const agent = agentIdOf(req);
  return agent === '' ? session : createHash('sha256').update(`${session}\n${agent}`).digest('base64url');
}

function send(call: Call, access: CodexAccess): Promise<Response> {
  const request = toResponsesRequest(call.body, call.model, { promptCacheKey: call.threadKey, names: call.names });
  return (call.deps.fetchImpl ?? fetch)(`${baseFor(access, call.deps)}/responses`, {
    method: 'POST',
    headers: headersFor(access, call.threadKey),
    body: JSON.stringify(request),
    signal: call.watch.signal,
    redirect: 'manual',
  });
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
  const upstream = await send(call, conn.codex);
  if (upstream.status !== 401) return upstream;
  await upstream.body?.cancel();
  const fresh = await call.deps.refresh(conn);
  if (fresh?.codex === null || fresh?.codex === undefined) throw new GatewayError(403, 'permission_error', RENEW_FAILED);
  return send(call, fresh.codex);
}

export async function codexMessages(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>, model: string, conn: Connection, deps: CodexDeps, watch: Watch): Promise<void> {
  const call: Call = { body, model, threadKey: threadKey(req), watch, deps, names: new ToolNames() };
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
