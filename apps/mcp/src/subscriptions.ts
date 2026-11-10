import { newId } from '@metro-labs/core/ids';
import { errMsg, log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { isRecord } from '@metro-labs/core/is-record';
import { EVENT_ERROR } from '@metro-labs/http/mcp-events';
import { MCP_EVENTS_PATH } from '@metro-labs/http/mcp-server-protocol';
import { newWebhookSecret } from '@metro-labs/http/standard-webhooks';
import type { SubscriptionChange, SubscriptionRow, WantedEvents } from '@metro-labs/connectors/db/connector-subscriptions';
import { isNotMigrated } from '@metro-labs/connectors/db/errors';
import type { McpDeps } from './deps.js';
import { VendorRpcError } from './errors.js';
import { receiveGap } from './events.js';
import { EventsRefused, subscribeTo, unsubscribeFrom, type Subscribed } from './events-client.js';
import { withOrgCredential } from './org-credential.js';
import { sealWebhookSecret, webhookSecretOf } from './receivers.js';
import { accessRefused, endedChange, refreshAt, retryAfter, SIGNED_OUT, signInMark, SUBSCRIPTION_TTL_MS } from './subscription-state.js';

const TICK_MS = 20_000;
const CLAIM_MS = 2 * 60_000;
const PARALLEL = 4;
const MESSAGE_MAX = 200;

type SubscribeDeps = Pick<McpDeps, 'key' | 'catalogue' | 'fetch' | 'now' | 'subscriptions' | 'events' | 'receivers' | 'waiters' | 'calls' | 'publicHost'>;

interface Wanted {
  connector: WantedEvents['connector'];
}

interface Failure {
  status: 'signed_out' | 'error';
  error: string;
}

const keyOf = (connector: string, agent: string, event: string): string => `${connector} ${agent} ${event}`;

export const callbackUrl = (publicHost: string, id: string): string => `https://${publicHost}${MCP_EVENTS_PATH}${id}`;

const said = (err: VendorRpcError, secret: string): string => err.message.replaceAll(secret, '[redacted]').replace(/\p{Cc}/gu, ' ').slice(0, MESSAGE_MAX);

function refusalOf(err: VendorRpcError, name: string, secret: string): Failure {
  const data = isRecord(err.data) ? err.data : {};
  if (err.rpcCode === EVENT_ERROR.forbidden) return { status: 'signed_out', error: data.reason === 'signed_out' ? SIGNED_OUT : accessRefused(name) };
  if (err.rpcCode === EVENT_ERROR.notFound) return { status: 'error', error: `This connector no longer offers ${name}.` };
  if (err.rpcCode === EVENT_ERROR.callbackEndpoint) return { status: 'error', error: `The connector could not reach Metro to deliver events${typeof data.reason === 'string' && /^[a-z0-9_]{1,32}$/.test(data.reason) ? ` (${data.reason})` : ''}. Metro tries again.` };
  if (err.rpcCode === EVENT_ERROR.resourceExhausted) return { status: 'error', error: 'The connector has no room for another subscription right now. Metro tries again.' };
  return { status: 'error', error: `The connector refused the subscription. ${said(err, secret)}` };
}

function failureOf(err: unknown, name: string, secret: string): Failure {
  if (err instanceof VendorRpcError) return refusalOf(err, name, secret);
  if (err instanceof EventsRefused) return { status: 'error', error: err.message };
  if (err instanceof ApiError && err.status === 424) return { status: 'signed_out', error: SIGNED_OUT };
  if (!(err instanceof ApiError)) log.warn({ err: errMsg(err).replaceAll(secret, '[redacted]') }, 'mcp: a subscription step failed');
  return { status: 'error', error: 'Metro could not reach the connector. It tries again.' };
}

function newRow(deps: SubscribeDeps, want: WantedEvents, event: string): SubscriptionRow {
  const id = newId();
  const owner = want.connector.owner;
  const now = deps.now();
  return {
    id,
    owner,
    connector: want.connector.id,
    agent: want.agent,
    event,
    secret: sealWebhookSecret(deps.key, { owner, id }, newWebhookSecret()),
    serverId: null,
    cursor: null,
    sender: null,
    status: 'pending',
    error: null,
    failures: 0,
    signedIn: signInMark(want.connector),
    subscribedAt: null,
    refreshBefore: null,
    nextAt: now,
    claimedUntil: 0,
    createdAt: now,
  };
}

async function rotated(deps: SubscribeDeps, row: SubscriptionRow, mark: string): Promise<{ row: SubscriptionRow; secret: string }> {
  if (row.signedIn === mark) return { row, secret: webhookSecretOf(deps.key, row) };
  const secret = newWebhookSecret();
  const change = { secret: sealWebhookSecret(deps.key, row, secret), serverId: null, signedIn: mark, status: 'pending', error: null, failures: 0 };
  await deps.subscriptions.update(row.id, change);
  deps.receivers.forget(row.id);
  return { row: { ...row, ...change }, secret };
}

function subscribedChange(now: number, mark: string, done: Subscribed): SubscriptionChange {
  return {
    serverId: done.result.id,
    cursor: done.result.cursor,
    sender: done.sender === null ? null : JSON.stringify(done.sender),
    status: 'active',
    error: null,
    failures: 0,
    signedIn: mark,
    subscribedAt: now,
    refreshBefore: done.result.refreshBefore,
    nextAt: refreshAt(now, done.result.refreshBefore),
  };
}

async function subscribe(deps: SubscribeDeps, claimed: SubscriptionRow, want: Wanted): Promise<void> {
  const mark = signInMark(want.connector);
  const { row, secret } = await rotated(deps, claimed, mark);
  const request = { name: row.event, url: callbackUrl(deps.publicHost, row.id), secret, cursor: row.cursor, ttlMs: SUBSCRIPTION_TTL_MS };
  try {
    const done = await withOrgCredential(deps, row.owner, row.connector, (target) => subscribeTo(target, deps.fetch, request));
    const now = deps.now();
    await deps.subscriptions.release(row.id, subscribedChange(now, mark, done));
    deps.receivers.forget(row.id);
    if (done.result.truncated && row.cursor !== null) await receiveGap(deps, { ...row, serverId: done.result.id }, `refresh ${String(now)}`);
    if (done.result.suspended) log.warn({ subscription: row.id, connector: row.connector, lastError: done.result.lastError }, 'mcp: the connector had stopped delivering events, and the refresh starts it again');
    log.info({ subscription: row.id, connector: row.connector, agent: row.agent, refresh: row.serverId !== null, truncated: done.result.truncated }, 'mcp: subscribed to a connector event');
  } catch (err) {
    const failure = failureOf(err, row.event, secret);
    await deps.subscriptions.release(row.id, failure.status === 'signed_out' ? endedChange(row, deps.now(), failure) : { ...failure, failures: row.failures + 1, nextAt: deps.now() + retryAfter(row.failures + 1) });
    log.info({ subscription: row.id, connector: row.connector, status: failure.status }, 'mcp: a connector event could not be subscribed; Metro tries again later');
  }
}

async function end(deps: SubscribeDeps, row: SubscriptionRow): Promise<void> {
  try {
    const connector = row.serverId === null ? null : await deps.subscriptions.connector(row.connector);
    if (connector !== null) await withOrgCredential(deps, connector.owner, connector.id, (target) => unsubscribeFrom(target, deps.fetch, row.event, callbackUrl(deps.publicHost, row.id)));
  } catch (err) {
    log.info({ subscription: row.id, err: err instanceof ApiError || err instanceof VendorRpcError ? err.message.slice(0, MESSAGE_MAX) : 'unexpected' }, 'mcp: the connector did not take the unsubscribe, so the subscription lapses by itself');
  }
  await deps.subscriptions.remove(row.id);
  deps.receivers.forget(row.id);
  log.info({ subscription: row.id, connector: row.connector, agent: row.agent }, 'mcp: a connector event is no longer wanted, so its subscription ended');
}

async function step(deps: SubscribeDeps, row: SubscriptionRow, want: Wanted | undefined): Promise<void> {
  const claimed = await deps.subscriptions.claim(row.id, deps.now(), CLAIM_MS);
  if (claimed === null) return;
  if (want === undefined) await end(deps, claimed);
  else if (claimed.nextAt > deps.now() && claimed.signedIn === signInMark(want.connector)) await deps.subscriptions.release(claimed.id, {});
  else await subscribe(deps, claimed, want);
}

async function inTurns<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, lane));
}

export async function reconcileSubscriptions(deps: SubscribeDeps): Promise<number> {
  const [wanted, rows] = await Promise.all([deps.subscriptions.wanted(), deps.subscriptions.rows()]);
  const wants = new Map<string, Wanted>();
  const known = new Map(rows.map((row) => [keyOf(row.connector, row.agent, row.event), row]));
  for (const want of wanted) {
    for (const event of want.events) {
      const key = keyOf(want.connector.id, want.agent, event);
      wants.set(key, { connector: want.connector });
      if (known.has(key)) continue;
      const row = newRow(deps, want, event);
      await deps.subscriptions.open(row);
      known.set(key, row);
    }
  }
  deps.receivers.note([...known.values()].map((row) => row.id));
  const now = deps.now();
  const due = [...known].filter(([key, row]) => {
    const want = wants.get(key);
    if (row.claimedUntil > now) return false;
    return want === undefined || row.nextAt <= now || row.signedIn !== signInMark(want.connector);
  });
  await inTurns(due, ([key, row]) =>
    step(deps, row, wants.get(key)).catch((err: unknown) => {
      log.warn({ subscription: row.id, err: errMsg(err) }, 'mcp: a subscription could not be kept up; Metro tries again');
    }),
  );
  return due.length;
}

export function startSubscriptions(deps: SubscribeDeps, everyMs = TICK_MS): () => void {
  let running = false;
  let quiet = false;
  const run = (): void => {
    if (running) return;
    running = true;
    reconcileSubscriptions(deps)
      .then(() => {
        quiet = false;
      })
      .catch((err: unknown) => {
        if (quiet) return;
        quiet = true;
        if (isNotMigrated(err)) log.warn('mcp: the connector event tables are not migrated yet, so subscriptions wait until api.metro.box migrates');
        else log.warn({ err: errMsg(err) }, 'mcp: subscriptions could not be checked, later failures stay quiet until one works');
      })
      .finally(() => {
        running = false;
      });
  };
  run();
  const timer = setInterval(run, everyMs);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}
