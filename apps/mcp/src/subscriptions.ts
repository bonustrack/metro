import { newId } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { EVENT_ERROR } from '@metro-labs/http/mcp-events';
import { MCP_EVENTS_PATH } from '@metro-labs/http/mcp-server-protocol';
import { newWebhookSecret } from '@metro-labs/http/standard-webhooks';
import { EVENT_KEEP_MS } from '@metro-labs/connectors/db/connector-events';
import type { ConnectorRow } from '@metro-labs/connectors/db/connectors';
import type { SubscriptionChange, SubscriptionRow, WantedEvents } from '@metro-labs/connectors/db/connector-subscriptions';
import { failureText, isNotMigrated } from '@metro-labs/connectors/db/errors';
import { detailOf } from '@metro-labs/connectors/model';
import type { McpDeps } from './deps.js';
import { VendorRpcError } from './errors.js';
import { recordEvent } from './events.js';
import { EventsRefused, subscribeTo, unsubscribeFrom } from './events-client.js';
import { withOrgCredential } from './org-credential.js';
import { sealWebhookSecret, webhookSecretOf } from './receivers.js';
import { deadlineFetch } from './vendor.js';

export const SUBSCRIPTION_TTL_MS = 24 * 60 * 60_000;
export const RETRY_MS = 60_000;
export const SIGNED_OUT_RETRY_MS = 24 * 60 * 60_000;
export const SIGNED_OUT = 'This connector is signed out. Sign in to it again to receive events.';
export const ACCESS_LOST = 'This connector says its access was lost. Sign in to it again to receive events.';
export const accessRefused = (name: string): string => `This connector does not let its sign-in receive ${name}. Sign in to it again with an account that may.`;

const RETRY_MAX_MS = 60 * 60_000;
const MIN_REFRESH_MS = 60_000;
const TICK_MS = 20_000;
const CLAIM_MS = 2 * 60_000;
const STEP_MS = 90_000;
const PARALLEL = 4;
const SAID_MAX = 200;

type SubscribeDeps = Pick<McpDeps, 'key' | 'catalogue' | 'fetch' | 'now' | 'subscriptions' | 'events' | 'receivers' | 'calls' | 'publicHost'>;

interface Failure {
  status: 'signed_out' | 'error';
  error: string;
}

const keyOf = (connector: string, agent: string, event: string): string => `${connector} ${agent} ${event}`;

export const callbackUrl = (publicHost: string, id: string): string => `https://${publicHost}${MCP_EVENTS_PATH}${id}`;

function signInMark(connector: Pick<ConnectorRow, 'authGeneration' | 'detail'>): string {
  const detail = detailOf(connector.detail);
  return [connector.authGeneration ?? '', detail.signedInAt ?? '', detail.verifiedAt ?? ''].join(' ');
}

const retryAfter = (failures: number): number => Math.min(RETRY_MS * 2 ** Math.min(failures - 1, 10), RETRY_MAX_MS);

export function failedChange(row: Pick<SubscriptionRow, 'failures'>, now: number, failure: Failure | { status: 'pending'; error: null }): SubscriptionChange {
  const failures = row.failures + 1;
  return { ...failure, failures, nextAt: now + (failure.status === 'signed_out' ? SIGNED_OUT_RETRY_MS : retryAfter(failures)) };
}

function refusalOf(err: VendorRpcError, name: string, secret: string): Failure {
  const data = isRecord(err.data) ? err.data : {};
  if (err.rpcCode === EVENT_ERROR.forbidden) return { status: 'signed_out', error: data.reason === 'signed_out' ? SIGNED_OUT : accessRefused(name) };
  if (err.rpcCode === EVENT_ERROR.notFound) return { status: 'error', error: `This connector no longer offers ${name}.` };
  if (err.rpcCode === EVENT_ERROR.callbackEndpoint) return { status: 'error', error: `The connector could not reach Metro to deliver events${typeof data.reason === 'string' && /^[a-z0-9_]{1,32}$/.test(data.reason) ? ` (${data.reason})` : ''}. Metro tries again.` };
  if (err.rpcCode === EVENT_ERROR.resourceExhausted) return { status: 'error', error: data.limit === 'verifications' ? 'The connector is checking Metro\'s address too often. Metro tries again in a few minutes.' : 'The connector has no room for another subscription right now. Metro tries again.' };
  return { status: 'error', error: `The connector refused the subscription: ${err.said.replaceAll(secret, '[redacted]').replace(/\p{Cc}/gu, ' ').slice(0, SAID_MAX)}` };
}

function failureOf(err: unknown, name: string, secret: string): Failure {
  if (err instanceof VendorRpcError) return refusalOf(err, name, secret);
  if (err instanceof EventsRefused) return { status: 'error', error: err.message };
  if (err instanceof ApiError && err.status === 424) return { status: 'signed_out', error: SIGNED_OUT };
  if (!(err instanceof ApiError)) log.warn({ err: failureText(err).replaceAll(secret, '[redacted]') }, 'mcp: a subscription step failed');
  return { status: 'error', error: 'Metro could not reach the connector. It tries again.' };
}

function newRow(deps: SubscribeDeps, want: WantedEvents, event: string): SubscriptionRow {
  const id = newId();
  const owner = want.connector.owner;
  return {
    id,
    owner,
    connector: want.connector.id,
    agent: want.agent,
    event,
    secret: sealWebhookSecret(deps.key, { owner, id }, newWebhookSecret()),
    cursor: null,
    sender: null,
    status: 'pending',
    error: null,
    failures: 0,
    signedIn: signInMark(want.connector),
    nextAt: deps.now(),
    claimedUntil: 0,
  };
}

async function resigned(deps: SubscribeDeps, row: SubscriptionRow, mark: string): Promise<SubscriptionRow> {
  if (row.signedIn === mark) return row;
  const change = { secret: sealWebhookSecret(deps.key, row, newWebhookSecret()), signedIn: mark, status: 'pending', error: null, failures: 0, nextAt: deps.now() };
  await deps.subscriptions.update(row.id, change);
  deps.receivers.forget(row.id);
  return { ...row, ...change };
}

function within(deps: SubscribeDeps): SubscribeDeps {
  const fetch = deadlineFetch(deps.fetch, STEP_MS);
  return { ...deps, fetch, catalogue: { ...deps.catalogue, fetch } };
}

async function subscribe(deps: SubscribeDeps, claimed: SubscriptionRow, connector: ConnectorRow): Promise<void> {
  const mark = signInMark(connector);
  const row = await resigned(deps, claimed, mark);
  const secret = webhookSecretOf(deps.key, row);
  const request = { name: row.event, url: callbackUrl(deps.publicHost, row.id), secret, cursor: row.cursor, ttlMs: SUBSCRIPTION_TTL_MS, maxAgeMs: EVENT_KEEP_MS };
  const bounded = within(deps);
  const done = await withOrgCredential(bounded, row.owner, row.connector, (target) => subscribeTo(target, bounded.fetch, request)).catch((err: unknown) => failureOf(err, row.event, secret));
  const now = deps.now();
  if ('status' in done) {
    await deps.subscriptions.release(row.id, failedChange(row, now, done));
    log.info({ subscription: row.id, connector: row.connector, status: done.status }, 'mcp: a connector event could not be subscribed; Metro tries again later');
    return;
  }
  const lifetime = done.result.refreshBefore === null ? SUBSCRIPTION_TTL_MS : done.result.refreshBefore - now;
  const change = { sender: JSON.stringify(done.sender), status: 'active', error: null, failures: 0, signedIn: mark, nextAt: now + Math.max(MIN_REFRESH_MS, Math.floor(lifetime / 2)) };
  await deps.subscriptions.release(row.id, change, { sent: row.cursor, next: done.result.cursor });
  const skipped = done.result.truncated && row.cursor !== null;
  if (skipped) recordEvent(deps, row, 'skipped', 0);
  log.info({ subscription: row.id, connector: row.connector, agent: row.agent, refresh: row.sender !== null, skipped }, 'mcp: subscribed to a connector event');
}

async function end(deps: SubscribeDeps, row: SubscriptionRow): Promise<void> {
  if (row.sender !== null) {
    const bounded = within(deps);
    await withOrgCredential(bounded, row.owner, row.connector, (target) => unsubscribeFrom(target, bounded.fetch, row.event, callbackUrl(deps.publicHost, row.id))).catch((err: unknown) => {
      log.info({ subscription: row.id, err: failureText(err) }, 'mcp: the connector did not take the unsubscribe, so the subscription lapses by itself');
    });
  }
  await deps.subscriptions.remove(row.id);
  deps.receivers.forget(row.id);
  log.info({ subscription: row.id, connector: row.connector, agent: row.agent }, 'mcp: a connector event is no longer wanted, so its subscription ended');
}

async function step(deps: SubscribeDeps, row: SubscriptionRow, connector: ConnectorRow | undefined): Promise<void> {
  const claimed = await deps.subscriptions.claim(row.id, deps.now(), CLAIM_MS);
  if (claimed === null) return;
  if (connector === undefined) await end(deps, claimed);
  else if (claimed.nextAt > deps.now() && claimed.signedIn === signInMark(connector)) await deps.subscriptions.release(claimed.id, {});
  else await subscribe(deps, claimed, connector);
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
  const wants = new Map<string, ConnectorRow>();
  const known = new Map(rows.map((row) => [keyOf(row.connector, row.agent, row.event), row]));
  for (const want of wanted) {
    for (const event of want.events) {
      const key = keyOf(want.connector.id, want.agent, event);
      wants.set(key, want.connector);
      if (known.has(key)) continue;
      const row = newRow(deps, want, event);
      await deps.subscriptions.open(row);
      known.set(key, row);
    }
  }
  deps.receivers.note([...known.values()].map((row) => row.id));
  const now = deps.now();
  const due = [...known].filter(([key, row]) => {
    const connector = wants.get(key);
    if (row.claimedUntil > now) return false;
    return connector === undefined || row.nextAt <= now || row.signedIn !== signInMark(connector);
  });
  await inTurns(due, ([key, row]) =>
    step(deps, row, wants.get(key)).catch((err: unknown) => {
      log.warn({ subscription: row.id, err: failureText(err) }, 'mcp: a subscription could not be kept up; Metro tries again');
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
        else log.warn({ err: failureText(err) }, 'mcp: subscriptions could not be checked, later failures stay quiet until one works');
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
