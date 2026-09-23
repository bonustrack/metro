import type { IncomingMessage, ServerResponse } from 'node:http';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg } from '@metro-labs/core/log';
import { assembleMessage, SseParser, type SseEvent } from './frames.js';
import { GatewayError, relayFrames, type Watch } from './forward.js';
import { UsageScanner } from './usage.js';

const STATUS_OF: Record<string, number> = { rate_limit_error: 429, invalid_request_error: 400, permission_error: 403, overloaded_error: 529 };

interface Slot<T> {
  refreshing: Promise<T> | null;
  latest: T | null;
}

export type TokenState<T> = Map<string, Slot<T>>;

export interface TokenSource<T extends { savedAt: string }> {
  label: string;
  stale: (tokens: T) => boolean;
  refresh: (tokens: T) => Promise<T>;
  save: (id: string, tokens: T) => void;
}

function slotFor<T>(state: TokenState<T>, id: string): Slot<T> {
  const found = state.get(id);
  if (found !== undefined) return found;
  const made: Slot<T> = { refreshing: null, latest: null };
  state.set(id, made);
  return made;
}

const newerThan = (a: { savedAt: string }, b: { savedAt: string }): boolean => Date.parse(a.savedAt) > Date.parse(b.savedAt);

export function refreshed<T extends { savedAt: string }>(state: TokenState<T>, id: string, tokens: T, source: TokenSource<T>): Promise<T> {
  const slot = slotFor(state, id);
  const latest = slot.latest;
  if (latest !== null && newerThan(latest, tokens) && !source.stale(latest)) return Promise.resolve(latest);
  if (slot.refreshing !== null) return slot.refreshing;
  const run = source
    .refresh(tokens)
    .then((fresh) => {
      source.save(id, fresh);
      slot.latest = fresh;
      return fresh;
    })
    .catch((err: unknown) => {
      throw new GatewayError(403, 'permission_error', `${source.label} sign-in expired (${errMsg(err)}): connect again on the Model page`);
    })
    .finally(() => {
      slot.refreshing = null;
    });
  slot.refreshing = run;
  return run;
}

export function currentOf<T extends { savedAt: string }>(state: TokenState<T>, id: string, tokens: T | null, source: TokenSource<T>, missing: string): Promise<T> {
  if (tokens === null) throw new GatewayError(400, 'invalid_request_error', missing);
  return source.stale(tokens) ? refreshed(state, id, tokens, source) : Promise.resolve(tokens);
}

export async function reach<T>(current: () => Promise<T>, again: (tokens: T) => Promise<T>, send: (tokens: T) => Promise<Response>): Promise<Response> {
  const tokens = await current();
  const upstream = await send(tokens);
  if (upstream.status !== 401) return upstream;
  await upstream.body?.cancel();
  return send(await again(tokens));
}

export function errorKind(status: number, invalid: readonly number[] = [400, 404]): string {
  if (status === 401 || status === 403) return 'permission_error';
  if (status === 429) return 'rate_limit_error';
  if (invalid.includes(status)) return 'invalid_request_error';
  return 'api_error';
}

export function sessionHeader(req: IncomingMessage): string {
  const raw = req.headers['x-claude-code-session-id'];
  return (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
}

interface Translator {
  readonly finished: boolean;
  close: (message?: string) => string;
}

export function relayTranslated(
  upstream: Response,
  res: ServerResponse,
  watch: Watch,
  key: string,
  translator: Translator,
  onEvent: (raw: SseEvent) => string,
): Promise<void> {
  const parser = new SseParser();
  const decoder = new TextDecoder();
  return relayFrames(upstream, res, watch, key, {
    push: (chunk, emit) => {
      for (const raw of parser.push(decoder.decode(chunk, { stream: true }))) emit(onEvent(raw));
    },
    close: () => translator.close(),
    idle: (message) => (translator.finished ? '' : translator.close(message)),
  });
}

export function answerWhole(res: ServerResponse, frames: string, key: string): void {
  const scanner = new UsageScanner(key);
  scanner.feed(frames);
  scanner.done();
  const message = assembleMessage(frames);
  const kind = isRecord(message.error) ? String(message.error.type) : '';
  res.writeHead(message.type === 'error' ? (STATUS_OF[kind] ?? 502) : 200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(message));
}

export const estimateTokens = (body: Record<string, unknown>): number => Math.ceil(JSON.stringify(body).length / 4);

export function countTokens(res: ServerResponse, body: Record<string, unknown>): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ input_tokens: estimateTokens(body) }));
}
