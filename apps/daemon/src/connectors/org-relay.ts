import { isRecord } from '@metro-labs/core/is-record';
import { ApiError } from '@metro-labs/http/api-error';
import { screenCalls, type Screened } from './relay-policy.js';
import type { RelaySession } from './relay-session.js';
import type { RelayTarget } from './relay-target.js';

type Ready = Extract<RelayTarget, { kind: 'ok' }>;
type Forward = (target: Ready, body: Uint8Array<ArrayBuffer> | null, signal: AbortSignal) => Promise<Response>;
type OrgExchange =
  | { kind: 'response'; upstream: Response; answers: Record<string, unknown>[] }
  | { kind: 'blocked'; screened: Screened };

const METHODS = new Set(['initialize', 'ping', 'tools/list', 'tools/call', 'notifications/initialized', 'notifications/cancelled']);

function requestBatch(body: Uint8Array | null): boolean {
  if (body === null) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(body)); }
  catch { throw new ApiError('Invalid organization connector request.', 400); }
  const batch = Array.isArray(parsed);
  const entries: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  if (entries.length === 0 || entries.some((item) => !validMessage(item))) throw new ApiError('This organization connector accepts MCP tool requests only.', 400);
  return batch;
}

function validMessage(item: unknown): boolean {
  if (!isRecord(item) || item.jsonrpc !== '2.0' || typeof item.method !== 'string' || !METHODS.has(item.method)) return false;
  if (item.method !== 'tools/call') return true;
  if (!isRecord(item.params) || typeof item.params.name !== 'string' || item.params.name === '') return false;
  return item.params.arguments === undefined || isRecord(item.params.arguments);
}

function ready(session: RelaySession, signal: AbortSignal): Ready {
  if (signal.aborted) throw new ApiError('This organization connector is no longer available.', 503);
  const target = session.current();
  if (target.kind === 'missing') throw new ApiError('No such organization connector.', 404);
  if (target.kind === 'signin') throw new ApiError('This organization connector needs signing in again.', 424);
  return target;
}

export async function exchangeOrg(id: string, session: RelaySession, body: Uint8Array<ArrayBuffer> | null, clientSignal: AbortSignal, forward: Forward): Promise<OrgExchange> {
  const signal = AbortSignal.any([clientSignal, session.signal]);
  const batch = requestBatch(body);
  let pending = body;
  const answers: Record<string, unknown>[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await session.target(attempt > 0);
    ready(session, signal);
    const screened = pending === null ? null : screenCalls(pending, id, session.blocker());
    if (screened !== null) {
      answers.push(...screened.answers);
      pending = screened.forward;
      if (pending === null) return { kind: 'blocked', screened: { forward: null, answers, batch } };
    }
    const target = ready(session, signal);
    const upstream = await forward(target, pending, signal);
    if (upstream.status !== 401 && upstream.status !== 403) return { kind: 'response', upstream, answers };
    await upstream.body?.cancel();
  }
  throw new ApiError('The organization connector rejected its credential. Check its sign-in in the organization settings.', 424);
}
