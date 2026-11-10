import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseId } from '@metro-labs/core/ids';
import { errMsg, log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { readBodyBytes } from '@metro-labs/http/api-http';
import { emailReceivedOf, webhookBodyOf, type WebhookBody } from '@metro-labs/http/mcp-events';
import { MCP_EVENTS_PATH } from '@metro-labs/http/mcp-server-protocol';
import { checkWebhook, webhookHeadersOf } from '@metro-labs/http/standard-webhooks';
import type { SubscriptionRow } from '@metro-labs/connectors/db/connector-subscriptions';
import type { McpDeps } from './deps.js';
import { receiveMail } from './mail.js';
import { signedInOf, signedOutOf, SIGNED_OUT_NOTE, webhookSecretOf } from './mail-state.js';
import { sendBody } from './mcp-http.js';

const BODY_MAX = 256 * 1024;

interface Answer {
  status: number;
  body: unknown;
}

type WebhookDeps = Pick<McpDeps, 'key' | 'inbox' | 'calls' | 'waiters' | 'now' | 'subscriptions'>;

const OK: Answer = { status: 200, body: { ok: true } };

async function eventAnswer(deps: WebhookDeps, sub: SubscriptionRow, body: Extract<WebhookBody, { type: 'event' }>): Promise<Answer> {
  if (body.name !== sub.event) {
    log.info({ subscription: sub.id, name: body.name.slice(0, 128) }, 'mcp: a connector sent an event Metro did not subscribe to');
    return OK;
  }
  const mail = emailReceivedOf(body.data);
  if (mail === null) {
    log.warn({ subscription: sub.id }, 'mcp: a connector sent a mail Metro cannot read, so it is refused for good');
    return { status: 410, body: { error: 'This mail is not in the email.received shape.' } };
  }
  const received = await receiveMail(deps, sub, body.eventId, mail);
  if (received === 'unassigned') return { status: 410, body: { error: 'This agent no longer has this connector.' } };
  await deps.subscriptions.cursor(sub.id, body.cursor);
  return OK;
}

async function terminated(deps: WebhookDeps, sub: SubscriptionRow, body: Extract<WebhookBody, { type: 'terminated' }>): Promise<void> {
  const connector = (await deps.subscriptions.connectors([sub.connector])).get(sub.connector);
  if (body.signedOut && connector !== undefined) {
    await deps.subscriptions.ended(sub.id, SIGNED_OUT_NOTE, deps.now(), signedOutOf(signedInOf(connector)));
    log.info({ subscription: sub.id }, 'mcp: the mailbox signed out on the connector, so its mail waits for a new sign-in');
    return;
  }
  await deps.subscriptions.ended(sub.id, `The connector ended the subscription: ${body.reason}`, deps.now());
  log.info({ subscription: sub.id }, 'mcp: a connector ended a mail subscription, so Metro subscribes again');
}

async function controlAnswer(deps: WebhookDeps, sub: SubscriptionRow, body: Exclude<WebhookBody, { type: 'event' }>): Promise<Answer> {
  if (body.type === 'verification') return { status: 200, body: { challenge: body.challenge } };
  if (body.type === 'gap') {
    await deps.subscriptions.cursor(sub.id, body.cursor);
    log.warn({ subscription: sub.id, connector: sub.connector }, 'mcp: the connector skipped mail it could no longer read (a gap) and starts again from now');
  }
  if (body.type === 'terminated') await terminated(deps, sub, body);
  return OK;
}

function parsed(bytes: Buffer): WebhookBody | null {
  try {
    return webhookBodyOf(JSON.parse(bytes.toString('utf8')));
  } catch {
    return null;
  }
}

async function answer(req: IncomingMessage, deps: WebhookDeps, id: string): Promise<Answer> {
  const bytes = await readBodyBytes(req, BODY_MAX);
  const headers = webhookHeadersOf(req.headers);
  if (headers === null) return { status: 401, body: { error: 'A delivery needs webhook-id, webhook-timestamp and webhook-signature.' } };
  const sub = await deps.subscriptions.find(id);
  if (sub === null) return { status: 410, body: { error: 'Metro has no subscription at this address.' } };
  const check = checkWebhook(webhookSecretOf(deps.key, sub), headers, bytes, deps.now());
  if (check !== 'ok') {
    log.warn({ subscription: sub.id, check }, 'mcp: a webhook delivery did not verify');
    return { status: 401, body: { error: check === 'stale' ? 'The webhook timestamp is more than 5 minutes off.' : 'The webhook signature does not verify.' } };
  }
  const body = parsed(bytes);
  if (body === null) return { status: 410, body: { error: 'The body is not an event or a control envelope.' } };
  return body.type === 'event' ? eventAnswer(deps, sub, body) : controlAnswer(deps, sub, body);
}

export function handleWebhookRequest(req: IncomingMessage, res: ServerResponse, deps: WebhookDeps): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (!path.startsWith(MCP_EVENTS_PATH)) return false;
  const id = parseId(path.slice(MCP_EVENTS_PATH.length));
  if (id === null) {
    sendBody(res, 404, { error: 'not found' });
    return true;
  }
  if (req.method !== 'POST') {
    sendBody(res, 405, { error: 'method not allowed' }, { allow: 'POST' });
    return true;
  }
  answer(req, deps, id)
    .then((done) => {
      sendBody(res, done.status, done.body);
    })
    .catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 413) {
        sendBody(res, 413, { error: 'A delivery is at most 256 KiB.' });
        return;
      }
      log.warn({ err: errMsg(err) }, 'mcp: a webhook delivery could not be handled');
      sendBody(res, 503, { error: 'mcp.metro.box could not take this delivery. Try again.' });
    });
  return true;
}
