import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseId } from '@metro-labs/core/ids';
import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { readBodyBytes } from '@metro-labs/http/api-http';
import { EVENT_ERROR, WEBHOOK_BODY_MAX, webhookBodyOf, type WebhookBody } from '@metro-labs/http/mcp-events';
import { MCP_EVENTS_PATH, MCP_RECEIVER_PATH } from '@metro-labs/http/mcp-server-protocol';
import { webhookFresh, webhookHeadersOf, webhookSigned, type WebhookHeaders } from '@metro-labs/http/standard-webhooks';
import { eventNamesOf } from '@metro-labs/connectors/db/connectors';
import type { SubscriptionRow } from '@metro-labs/connectors/db/connector-subscriptions';
import { failureText, isNotMigrated } from '@metro-labs/connectors/db/errors';
import type { McpDeps } from './deps.js';
import { receiveEvent, recordEvent } from './events.js';
import { sendBody } from './mcp-http.js';
import { ACCESS_LOST, failedChange } from './subscriptions.js';

interface Answer {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

type WebhookDeps = Pick<McpDeps, 'key' | 'events' | 'subscriptions' | 'receivers' | 'calls' | 'waiters' | 'now'>;

const READING_EACH = 4;
const READING_ALL = 128;
const BODY_READ_MS = 5_000;
const UNSIGNED_LOG_MS = 60_000;
const OK: Answer = { status: 200, body: { ok: true } };
const GONE: Answer = { status: 410, body: { error: 'Metro has no subscription at this address.' } };
const UNWANTED: Answer = { status: 410, body: { error: 'This agent does not receive this event.' } };
const UNUSABLE: Answer = { status: 410, body: { error: 'Metro cannot use this body, so it should not be sent again.' } };
const UNSIGNED: Answer = { status: 401, body: { error: 'This delivery is not signed for this subscription, or its timestamp is more than 5 minutes off.' } };
const TOO_LARGE: Answer = { status: 413, body: { error: 'A delivery is at most 256 KiB.' } };
const BUSY: Answer = { status: 503, body: { error: 'mcp.metro.box cannot take this yet. Try again.' }, headers: { 'retry-after': '5' } };

const reading = new Map<string, number>();
let readingAll = 0;
let quiet = false;
let unsignedLoggedAt = 0;

function drained(req: IncomingMessage): Promise<boolean> {
  if (req.complete) return Promise.resolve(true);
  return new Promise((resolve) => {
    let seen = 0;
    const done = (whole: boolean): void => {
      req.off('data', count);
      resolve(whole);
    };
    const count = (chunk: Buffer): void => {
      seen += chunk.length;
      if (seen > WEBHOOK_BODY_MAX) done(false);
    };
    req.on('data', count);
    req.once('end', () => {
      done(true);
    });
    req.once('close', () => {
      done(false);
    });
  });
}

async function refuse(req: IncomingMessage, res: ServerResponse, answer: Answer): Promise<void> {
  const whole = await drained(req);
  sendBody(res, answer.status, answer.body, { ...answer.headers, ...(whole ? {} : { connection: 'close' }) });
}

async function bodyOf(req: IncomingMessage): Promise<Buffer> {
  const slow = setTimeout(() => {
    req.destroy();
  }, BODY_READ_MS);
  slow.unref();
  try {
    return await readBodyBytes(req, WEBHOOK_BODY_MAX);
  } finally {
    clearTimeout(slow);
  }
}

async function authentic(deps: WebhookDeps, id: string, headers: WebhookHeaders, bytes: Buffer, secret: string): Promise<boolean> {
  if (webhookSigned(secret, headers, bytes)) return true;
  const fresh = await deps.receivers.reload(id, secret);
  if (fresh !== null && webhookSigned(fresh, headers, bytes)) return true;
  const now = Date.now();
  if (now - unsignedLoggedAt >= UNSIGNED_LOG_MS) log.warn({ subscription: id }, 'mcp: a webhook delivery did not verify (said once a minute at most)');
  unsignedLoggedAt = now;
  return false;
}

async function eventAnswer(deps: WebhookDeps, id: string, event: Extract<WebhookBody, { kind: 'event' }>): Promise<Answer> {
  const receiver = await deps.subscriptions.receiver(id);
  if (receiver === null) return GONE;
  const sub = receiver.subscription;
  if (event.name !== sub.event || !eventNamesOf(receiver.wanted).includes(sub.event)) return UNWANTED;
  if (sub.sender === null || (await receiveEvent(deps, receiver, event)) === 'full') return BUSY;
  if (event.cursor !== null) await deps.subscriptions.keepCursor(id, event.cursor);
  return OK;
}

async function controlAnswer(deps: WebhookDeps, id: string, body: Exclude<WebhookBody, { kind: 'event' }>): Promise<Answer> {
  if (body.kind === 'verification') return { status: 200, body: { challenge: body.challenge } };
  const sub = await deps.subscriptions.find(id);
  if (sub === null) return GONE;
  if (body.kind === 'gap') return gap(deps, sub, body.cursor);
  const lost = body.code === EVENT_ERROR.forbidden;
  await deps.subscriptions.update(id, failedChange(sub, deps.now(), lost ? { status: 'signed_out', error: ACCESS_LOST } : { status: 'pending', error: null }));
  log.info({ subscription: id, connector: sub.connector, code: body.code }, lost ? 'mcp: a connector ended a subscription because access was lost, so it waits for a new sign-in' : 'mcp: a connector ended a subscription, so Metro subscribes again');
  return OK;
}

async function gap(deps: WebhookDeps, sub: SubscriptionRow, cursor: string | null): Promise<Answer> {
  if (cursor !== null) await deps.subscriptions.keepCursor(sub.id, cursor);
  recordEvent(deps, sub, 'skipped', 0);
  log.warn({ subscription: sub.id, connector: sub.connector }, 'mcp: a connector skipped events it could no longer read (a gap)');
  return OK;
}

function parsed(bytes: Buffer): WebhookBody | null {
  try {
    return webhookBodyOf(JSON.parse(bytes.toString('utf8')));
  } catch {
    return null;
  }
}

async function taken(req: IncomingMessage, deps: WebhookDeps, id: string, headers: WebhookHeaders, secret: string): Promise<Answer> {
  const bytes = await bodyOf(req);
  if (!(await authentic(deps, id, headers, bytes, secret))) return UNSIGNED;
  const body = parsed(bytes);
  if (body === null) return UNUSABLE;
  return body.kind === 'event' ? eventAnswer(deps, id, body) : controlAnswer(deps, id, body);
}

function slot(id: string): (() => void) | null {
  const mine = reading.get(id) ?? 0;
  if (mine >= READING_EACH || readingAll >= READING_ALL) return null;
  reading.set(id, mine + 1);
  readingAll += 1;
  return () => {
    readingAll -= 1;
    const left = (reading.get(id) ?? 1) - 1;
    if (left > 0) reading.set(id, left);
    else reading.delete(id);
  };
}

async function serve(req: IncomingMessage, res: ServerResponse, deps: WebhookDeps, id: string): Promise<void> {
  const headers = webhookHeadersOf(req.headers);
  if (headers === null || !webhookFresh(headers, deps.now())) return refuse(req, res, UNSIGNED);
  if (Number(req.headers['content-length'] ?? '0') > WEBHOOK_BODY_MAX) return refuse(req, res, TOO_LARGE);
  const found = await deps.receivers.find(id);
  if (found === null) return refuse(req, res, GONE);
  const release = found === 'busy' ? null : slot(id);
  if (found === 'busy' || release === null) return refuse(req, res, BUSY);
  try {
    const done = await taken(req, deps, id, headers, found.secret);
    quiet = false;
    sendBody(res, done.status, done.body, done.headers);
  } finally {
    release();
  }
}

function failed(res: ServerResponse, err: unknown): void {
  if (err instanceof ApiError && err.status === 413) {
    sendBody(res, TOO_LARGE.status, TOO_LARGE.body, { connection: 'close' });
    return;
  }
  if (!quiet) {
    if (isNotMigrated(err)) log.warn('mcp: the connector event tables are not migrated yet, so deliveries are asked to come again until api.metro.box migrates');
    else log.warn({ err: failureText(err) }, 'mcp: a webhook delivery could not be handled, later failures stay quiet until one works');
  }
  quiet = true;
  sendBody(res, BUSY.status, BUSY.body, { ...BUSY.headers, connection: 'close' });
}

export function handleReceiverDocument(req: IncomingMessage, res: ServerResponse): boolean {
  if ((req.url ?? '').split('?')[0] !== MCP_RECEIVER_PATH) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') sendBody(res, 405, { error: 'method not allowed' }, { allow: 'GET' });
  else sendBody(res, 200, { receivers: [MCP_EVENTS_PATH] }, { 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*' });
  return true;
}

export function handleWebhookRequest(req: IncomingMessage, res: ServerResponse, deps: WebhookDeps): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (!path.startsWith(MCP_EVENTS_PATH)) return false;
  const id = parseId(path.slice(MCP_EVENTS_PATH.length));
  const work = req.method !== 'POST' ? refuse(req, res, { status: 405, body: { error: 'method not allowed' }, headers: { allow: 'POST' } }) : id === null ? refuse(req, res, GONE) : serve(req, res, deps, id);
  work.catch((err: unknown) => {
    failed(res, err);
  });
  return true;
}
