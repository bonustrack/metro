import type { IncomingMessage, ServerResponse } from 'node:http';
import { whyUnreachable } from '@metro-labs/http/connector-reach';
import { noteHealth } from './health.js';
import type { RelayTarget } from './relay-target.js';
import type { RelaySession } from './relay-session.js';
import { isRelaySse, passiveRelayListener, type PassiveSseListener } from './relay-passive.js';
import { isOrgRelayId } from './relay-id.js';
import { exchangeOrg } from './org-relay.js';
import { assertLocalMigrationUse, migrationSource, withLocalMigrationOperation } from './migration-guard.js';
import { agentsDir } from '../agents/files.js';
import { migrationRequestEffectful, type MigrationOperation } from './migration-operations.js';
import { ApiError } from '@metro-labs/http/api-error';
import { errMsg, log } from '@metro-labs/core/log';
import { answerBlocked, mergeBlocked, screenCalls, type BlockedReason } from './relay-policy.js';

export interface RelayApiDeps {
  migrationDir?: string;
  target: (connectorId: string, force: boolean) => Promise<RelayTarget>;
  identify: (req: IncomingMessage) => { subject: string; agentId: string } | null;
  signedOut: (connectorId: string) => void;
  blocked?: BlockedReason;
  open?: (connectorId: string) => RelaySession | null;
}

const ID_PATH_RE = /^\/relay\/((?:org-)?[A-Za-z0-9][A-Za-z0-9_-]{10})$/;
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
  sensitive = false,
): Promise<Response> {
  const firstByte = setTimeout(() => {
    log.warn(sensitive ? {} : { url: target.url }, 'relay: upstream sent no response in time');
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

function startKeepalive(res: ServerResponse, listener?: PassiveSseListener): Keepalive {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    timer = setTimeout(() => {
      try {
        if (listener?.keepaliveAllowed() !== false) res.write(': keepalive\n\n');
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

function drainedOrClosed(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
  });
}

async function pumpBody(
  res: ServerResponse,
  body: ReadableStream<Uint8Array>,
  touch: () => void,
  listener?: PassiveSseListener,
): Promise<void> {
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    listener?.observe(value);
    touch();
    if (listener !== undefined) listener.forwarding = true;
    if (!res.write(value)) await drainedOrClosed(res);
    if (listener !== undefined) listener.forwarding = false;
  }
}

function passedHeaders(upstream: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of PASS_RES) {
    const value = upstream.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  return headers;
}

async function pipe(res: ServerResponse, upstream: Response, answers: Record<string, unknown>[], listener?: PassiveSseListener): Promise<void> {
  const headers = passedHeaders(upstream);
  if (answers.length > 0 && (upstream.status === 200 || upstream.status === 202)) {
    await mergeBlocked(res, upstream, headers, answers);
    return;
  }
  const sse = isRelaySse(headers['content-type']);
  if (sse) headers['x-accel-buffering'] = 'no';
  res.writeHead(upstream.status, headers);
  if (sse) res.flushHeaders();
  if (upstream.body === null) {
    res.end();
    return;
  }
  const keepalive = sse ? startKeepalive(res, listener) : null;
  try {
    await pumpBody(res, upstream.body, () => keepalive?.touch(), listener);
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
  connectorId: string,
  deps: RelayApiDeps,
  body: Uint8Array<ArrayBuffer> | null,
  signal: AbortSignal,
  dispatch: MigrationOperation['dispatch'],
): Promise<Exchanged> {
  assertLocalMigrationUse(connectorId, deps.migrationDir);
  const target = await deps.target(connectorId, false);
  assertLocalMigrationUse(connectorId, deps.migrationDir);
  if (target.kind !== 'ok') return { kind: target.kind };
  let upstream = await dispatch(() => forward(req, target, body, signal), { effectful: migrationRequestEffectful(req.method, body) });
  if (!authFailed(upstream.status)) return { kind: 'response', upstream };
  await upstream.body?.cancel();
  assertLocalMigrationUse(connectorId, deps.migrationDir);
  const fresh = await deps.target(connectorId, true);
  assertLocalMigrationUse(connectorId, deps.migrationDir);
  if (fresh.kind !== 'ok') return { kind: 'signin' };
  upstream = await dispatch(() => forward(req, fresh, body, signal), { effectful: migrationRequestEffectful(req.method, body) });
  if (!authFailed(upstream.status)) return { kind: 'response', upstream };
  await upstream.body?.cancel();
  return { kind: 'signin' };
}

async function relayExchange(
  req: IncomingMessage,
  res: ServerResponse,
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
  try {
    await relayOnce(req, res, connectorId, deps, control);
  } catch (err) {
    if (!control.signal.aborted) throw err;
    log.debug({ connector: connectorId }, 'relay: the client left before the answer ended');
    if (!res.writableEnded) res.end();
  }
}

async function deliver(
  res: ServerResponse,
  connectorId: string,
  deps: RelayApiDeps,
  out: Exchanged,
  answers: Record<string, unknown>[],
  listener?: PassiveSseListener,
): Promise<void> {
  if (out.kind === 'missing') {
    answer(res, 404, { error: 'no such connector' });
    return;
  }
  if (out.kind === 'signin') {
    noteHealth(connectorId, false, 'the sign-in has expired, connect it again');
    deps.signedOut(connectorId);
    signinAnswer(res, connectorId);
    return;
  }
  if (out.upstream.status >= 300 && out.upstream.status < 400) {
    await out.upstream.body?.cancel();
    noteHealth(connectorId, false, 'the connector redirected; metro does not follow');
    answer(res, 502, { error: 'the connector redirected; metro does not follow' });
    return;
  }
  const { status } = out.upstream;
  noteHealth(connectorId, status < 400, status < 400 ? null : `the connector answered ${String(status)}`);
  await pipe(res, out.upstream, answers, listener);
}

async function relayOrg(req: IncomingMessage, res: ServerResponse, id: string, deps: RelayApiDeps, read: Uint8Array<ArrayBuffer> | null, signal: AbortSignal): Promise<void> {
  const session = deps.open?.(id);
  if (session === undefined || session === null) throw new ApiError('Organization connector tools are not switched on yet.', 503);
  try {
    const out = await exchangeOrg(id, session, read, signal, (target, body, guard) => {
      const send = () => forward(req, target, body, guard, true);
      return session.dispatch?.(send, migrationRequestEffectful(req.method, body)) ?? send();
    });
    if (out.kind === 'blocked') answerBlocked(res, out.screened);
    else await deliver(res, id, deps, out, out.answers);
  } finally { session.close(); }
}

async function relayOnce(
  req: IncomingMessage,
  res: ServerResponse,
  connectorId: string,
  deps: RelayApiDeps,
  control: AbortController,
): Promise<void> {
  const { signal } = control;
  const read = req.method === 'POST' ? await readCapped(req) : null;
  const dir = deps.migrationDir ?? agentsDir();
  if (isOrgRelayId(connectorId) || migrationSource(connectorId, dir)?.phase === 'active') return relayOrg(req, res, connectorId, deps, read, signal);
  await withLocalMigrationOperation(connectorId, dir, async (operation) => {
    const screened = read === null || deps.blocked === undefined ? null : screenCalls(read, connectorId, deps.blocked);
    if (screened?.forward === null) {
      answerBlocked(res, screened);
      return;
    }
    const out = await exchange(req, connectorId, deps, screened === null ? read : screened.forward, signal, operation.dispatch);
    const listener = out.kind === 'response' ? passiveRelayListener(req, res, out.upstream, operation, () => { control.abort(); }) : undefined;
    await deliver(res, connectorId, deps, out, screened?.answers ?? [], listener);
  });
}

function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  connectorId: string,
  deps: RelayApiDeps,
): void {
  const who = deps.identify(req);
  if (who === null) {
    answer(res, 401, { error: 'unauthorized' });
    return;
  }
  relayExchange(req, res, connectorId, deps)
    .catch((err: unknown) => {
      if (err instanceof ApiError) {
        answer(res, err.status, { error: err.message });
        if (!res.writableEnded) res.end();
      } else if (isOrgRelayId(connectorId)) {
        log.warn({ connector: connectorId }, 'organization relay: request failed');
        answer(res, 503, { error: 'The organization connector is unavailable. Try again.' });
        if (!res.writableEnded) res.end();
      } else {
        log.warn({ err: errMsg(err), connector: connectorId }, 'relay: failed');
        noteHealth(connectorId, false, `metro could not reach the connector: ${whyUnreachable(err)}`);
        answer(res, 502, { error: `metro could not reach the connector: ${whyUnreachable(err)}` });
        if (!res.writableEnded) res.end();
      }
      closeIfBodyUnread(req, res);
    });
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
