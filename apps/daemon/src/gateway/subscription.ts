import type { IncomingMessage, ServerResponse } from 'node:http';
import { isRecord } from '@metro-labs/core/is-record';
import { assembleMessage, SseParser, type SseEvent } from './frames.js';
import { relayFrames, type Watch } from './forward.js';
import { UsageScanner } from './usage.js';

const STATUS_OF: Record<string, number> = { rate_limit_error: 429, invalid_request_error: 400, permission_error: 403, overloaded_error: 529 };

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
