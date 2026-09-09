import type { IncomingMessage, ServerResponse } from 'node:http';

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly kind: string,
    message: string,
  ) {
    super(message);
  }
}

export const BODY_MAX = 64 * 1024 * 1024;
const DRAIN_FACTOR = 2;
const PING_MS = 25_000;
const IDLE_MS = 300_000;
const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
  'accept-encoding',
  'x-metro-key',
]);
const RESPONSE_DROP = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive']);

export function sendError(res: ServerResponse, status: number, kind: string, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: kind, message } }));
}

export const errorFrame = (kind: string, message: string): string => `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: kind, message } })}\n\n`;

export const providerStatus = (status: number): number => (status === 401 ? 403 : status);

export const idleMs = (): number => Number(process.env.METRO_GATEWAY_IDLE_MS) || IDLE_MS;

export const idleMessage = (ms: number): string => `metro gateway: the provider sent nothing for ${String(Math.round(ms / 1000))}s; giving up on this request`;

export interface Watch {
  signal: AbortSignal;
  ms: number;
  touch: () => void;
  idle: () => boolean;
  stop: () => void;
}

export function watchUpstream(res: ServerResponse, ms = idleMs()): Watch {
  const control = new AbortController();
  let expired = false;
  let timer: NodeJS.Timeout | null = null;
  const stop = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const arm = (): void => {
    stop();
    timer = setTimeout(() => {
      expired = true;
      control.abort();
    }, ms);
    timer.unref();
  };
  res.on('close', () => {
    stop();
    if (!res.writableEnded) control.abort();
  });
  arm();
  return { signal: control.signal, ms, touch: arm, idle: () => expired, stop };
}

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  let over = false;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > BODY_MAX) {
      over = true;
      if (total > BODY_MAX * DRAIN_FACTOR) break;
      continue;
    }
    chunks.push(buf);
  }
  if (over) throw new GatewayError(413, 'invalid_request_error', 'request too large');
  return Buffer.concat(chunks);
}

export function parseJson(raw: Buffer): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new GatewayError(400, 'invalid_request_error', 'body must be JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new GatewayError(400, 'invalid_request_error', 'body must be a JSON object');
  return parsed as Record<string, unknown>;
}

export function forwardedHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(name) || value === undefined) continue;
    out[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

export function anthropicHeaders(req: IncomingMessage, apiKey: string): Record<string, string> {
  const headers = forwardedHeaders(req);
  delete headers.authorization;
  const betas = (headers['anthropic-beta'] ?? '')
    .split(',')
    .map((beta) => beta.trim())
    .filter((beta) => beta !== '' && !beta.includes('oauth'));
  if (betas.length > 0) headers['anthropic-beta'] = betas.join(',');
  else delete headers['anthropic-beta'];
  headers['x-api-key'] = apiKey;
  return headers;
}

export interface PipeOptions {
  keepalive?: boolean;
  ownCredential?: boolean;
}

function openResponse(upstream: Response, res: ServerResponse, opts: PipeOptions): boolean {
  const headers: Record<string, string> = {};
  upstream.headers.forEach((value, name) => {
    if (!RESPONSE_DROP.has(name)) headers[name] = value;
  });
  res.writeHead(opts.ownCredential === true ? providerStatus(upstream.status) : upstream.status, headers);
  return (upstream.headers.get('content-type') ?? '').startsWith('text/event-stream');
}

async function pump(body: ReadableStream<Uint8Array>, res: ServerResponse, watch: Watch): Promise<void> {
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    watch.touch();
    res.write(value);
  }
}

export async function pipeResponse(upstream: Response, res: ServerResponse, watch: Watch, opts: PipeOptions = {}): Promise<void> {
  const streaming = openResponse(upstream, res, opts);
  const body = upstream.body;
  if (body === null) {
    res.end();
    return;
  }
  const ping = opts.keepalive === true && streaming ? setInterval(() => res.write('event: ping\ndata: {"type":"ping"}\n\n'), PING_MS) : null;
  try {
    await pump(body, res, watch);
  } catch (err) {
    if (!watch.idle()) throw err;
    if (streaming) res.write(errorFrame('api_error', idleMessage(watch.ms)));
  } finally {
    if (ping !== null) clearInterval(ping);
    watch.stop();
    res.end();
  }
}

export function upstreamMessage(text: string, fallback: string): string {
  if (text === '') return fallback;
  try {
    const parsed = JSON.parse(text) as { message?: unknown; Message?: unknown; error?: { message?: unknown } };
    const message = parsed.message ?? parsed.Message ?? parsed.error?.message;
    return typeof message === 'string' && message !== '' ? message : text;
  } catch {
    return text;
  }
}
