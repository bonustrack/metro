import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RelayTarget } from '../db/connector-relay.js';
import { cliIdentity } from './api-http.js';
import { ApiError } from './api-error.js';
import { errMsg, log } from './log.js';

export interface RelayApiDeps {
  target: (
    collectionId: string,
    connectorId: string,
    force: boolean,
  ) => Promise<RelayTarget>;
}

const ID_PATH_RE = /^\/relay\/([A-Za-z0-9][A-Za-z0-9_-]{10})$/;
const METHODS = new Set(['POST', 'GET', 'DELETE']);
const RELAY_BODY_MAX = 8 * 1024 * 1024;
const FIRST_BYTE_MS = 120_000;
const PASS_REQ = [
  'accept',
  'content-type',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
] as const;
const PASS_RES = [
  'content-type',
  'mcp-session-id',
  'mcp-protocol-version',
  'cache-control',
] as const;

const keepaliveMs = (): number =>
  Number(process.env.METRO_RELAY_KEEPALIVE_MS) || 25_000;

const reconnectUrl = (id: string): string =>
  `https://metro.box/#/connector/${id}`;

function answer(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const signinAnswer = (res: ServerResponse, id: string): void => {
  answer(res, 424, {
    error: 'this connector needs signing in again',
    reconnect: reconnectUrl(id),
  });
};

function closeIfBodyUnread(req: IncomingMessage, res: ServerResponse): void {
  if (req.readableEnded) return;
  const drop = (): void => {
    req.socket?.destroy();
  };
  if (res.writableFinished) drop();
  else res.once('finish', drop);
}

async function readCapped(req: IncomingMessage): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > RELAY_BODY_MAX)
    throw new ApiError('relay body exceeds 8 MiB', 413);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > RELAY_BODY_MAX)
      throw new ApiError('relay body exceeds 8 MiB', 413);
    chunks.push(buf);
  }
  const merged = Buffer.concat(chunks);
  const out = new Uint8Array(new ArrayBuffer(merged.byteLength));
  out.set(merged);
  return out;
}

function upstreamHeaders(
  req: IncomingMessage,
  injected: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of PASS_REQ) {
    const value = req.headers[name];
    if (typeof value === 'string') out[name] = value;
  }
  return { ...out, ...injected };
}

async function forward(
  req: IncomingMessage,
  target: { url: string; headers: Record<string, string> },
  body: Uint8Array<ArrayBuffer> | null,
  signal: AbortSignal,
): Promise<Response> {
  const firstByte = setTimeout(() => {
    log.warn({ url: target.url }, 'relay: upstream sent no response in time');
  }, FIRST_BYTE_MS);
  firstByte.unref?.();
  try {
    return await fetch(target.url, {
      method: req.method,
      headers: upstreamHeaders(req, target.headers),
      ...(body === null ? {} : { body }),
      signal,
      redirect: 'manual',
    });
  } finally {
    clearTimeout(firstByte);
  }
}

interface Keepalive {
  touch: () => void;
  stop: () => void;
}

function startKeepalive(res: ServerResponse): Keepalive {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    timer = setTimeout(() => {
      try {
        res.write(': keepalive\n\n');
      } catch {
        log.debug('relay: keepalive write failed');
      }
      arm();
    }, keepaliveMs());
    timer.unref?.();
  };
  arm();
  return {
    touch: (): void => {
      if (timer) clearTimeout(timer);
      arm();
    },
    stop: (): void => {
      if (timer) clearTimeout(timer);
    },
  };
}

async function pumpBody(
  res: ServerResponse,
  body: ReadableStream<Uint8Array>,
  touch: () => void,
): Promise<void> {
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    touch();
    const ok = res.write(value);
    if (!ok)
      await new Promise((resolve) => {
        res.once('drain', resolve);
      });
  }
}

async function pipe(res: ServerResponse, upstream: Response): Promise<void> {
  const headers: Record<string, string> = {};
  for (const name of PASS_RES) {
    const value = upstream.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  const sse = (headers['content-type'] ?? '').includes('text/event-stream');
  if (sse) headers['x-accel-buffering'] = 'no';
  res.writeHead(upstream.status, headers);
  if (upstream.body === null) {
    res.end();
    return;
  }
  const keepalive = sse ? startKeepalive(res) : null;
  try {
    await pumpBody(res, upstream.body, () => keepalive?.touch());
  } finally {
    keepalive?.stop();
  }
  res.end();
}

const authFailed = (status: number): boolean =>
  status === 401 || status === 403;

type Exchanged =
  | { kind: 'response'; upstream: Response }
  | { kind: 'missing' }
  | { kind: 'signin' };

async function exchange(
  req: IncomingMessage,
  collectionId: string,
  connectorId: string,
  deps: RelayApiDeps,
  body: Uint8Array<ArrayBuffer> | null,
  signal: AbortSignal,
): Promise<Exchanged> {
  const target = await deps.target(collectionId, connectorId, false);
  if (target.kind !== 'ok') return { kind: target.kind };
  let upstream = await forward(req, target, body, signal);
  if (!authFailed(upstream.status)) return { kind: 'response', upstream };
  await upstream.body?.cancel();
  const fresh = await deps.target(collectionId, connectorId, true);
  if (fresh.kind !== 'ok') return { kind: 'signin' };
  upstream = await forward(req, fresh, body, signal);
  if (!authFailed(upstream.status)) return { kind: 'response', upstream };
  await upstream.body?.cancel();
  return { kind: 'signin' };
}

async function relayExchange(
  req: IncomingMessage,
  res: ServerResponse,
  collectionId: string,
  connectorId: string,
  deps: RelayApiDeps,
): Promise<void> {
  const control = new AbortController();
  const bail = (): void => {
    if (!res.writableEnded) control.abort();
  };
  res.once('close', bail);
  res.socket?.once('close', bail);
  res.once('finish', () => {
    res.socket?.removeListener('close', bail);
  });
  const body = req.method === 'POST' ? await readCapped(req) : null;
  const out = await exchange(
    req,
    collectionId,
    connectorId,
    deps,
    body,
    control.signal,
  );
  if (out.kind === 'missing') {
    answer(res, 404, { error: 'no such connector' });
    return;
  }
  if (out.kind === 'signin') {
    signinAnswer(res, connectorId);
    return;
  }
  if (out.upstream.status >= 300 && out.upstream.status < 400) {
    await out.upstream.body?.cancel();
    answer(res, 502, { error: 'the connector redirected; metro does not follow' });
    return;
  }
  await pipe(res, out.upstream);
}

function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  connectorId: string,
  deps: RelayApiDeps,
): void {
  const who = cliIdentity(req);
  if (who === null) {
    answer(res, 401, { error: 'unauthorized' });
    return;
  }
  relayExchange(req, res, who.collectionId, connectorId, deps).catch(
    (err: unknown) => {
      if (err instanceof ApiError) {
        answer(res, err.status, { error: err.message });
      } else {
        log.warn({ err: errMsg(err), connector: connectorId }, 'relay: failed');
        answer(res, 502, { error: 'metro could not reach the connector' });
        if (!res.writableEnded) res.end();
      }
      closeIfBodyUnread(req, res);
    },
  );
}

export function handleRelayRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RelayApiDeps,
): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (path !== '/relay' && !path.startsWith('/relay/')) return false;
  const match = ID_PATH_RE.exec(path);
  if (match?.[1] === undefined) {
    answer(res, 404, { error: 'no such connector' });
    return true;
  }
  if (!METHODS.has(req.method ?? '')) {
    answer(res, 405, { error: 'method not allowed' });
    return true;
  }
  dispatch(req, res, match[1], deps);
  return true;
}
