import { newId } from '@metro-labs/core/ids';
import { errMsg, log } from '@metro-labs/core/log';
import { EVENTS_SUBSCRIBE, EVENTS_UNSUBSCRIBE, SIGNED_OUT_CODE, subscribeAnswerOf, type SubscribeAnswer } from '@metro-labs/http/mcp-events';
import { MCP_EVENTS_PATH } from '@metro-labs/http/mcp-server-protocol';
import { newWebhookSecret } from '@metro-labs/http/standard-webhooks';
import type { ConnectorRow } from '@metro-labs/connectors/db/connectors';
import type { SubscriptionRow, WantedSubscription } from '@metro-labs/connectors/db/connector-subscriptions';
import { isUndefinedTable } from '@metro-labs/connectors/db/errors';
import { sealSecret } from '@metro-labs/connectors/secrets';
import { targetOf, withCredential } from './credential.js';
import type { McpDeps } from './deps.js';
import { VendorRpcError } from './errors.js';
import { signedInOf, signedOutOf, SIGNED_OUT_NOTE, webhookSecretOf } from './mail-state.js';
import { callVendorMethod } from './vendor.js';

export const SUBSCRIPTION_TTL_MS = 24 * 60 * 60_000;
export const RETRY_MS = 5 * 60_000;
const REFRESH_EARLY_MS = 2 * 60 * 60_000;
const TICK_MS = 60_000;
const LEASE = 'connector-subscriptions';
const LEASE_MS = 3 * 60_000;
const SUBSCRIBE_MS = 30_000;
const STEPS_MAX = 50;

type SubscribeDeps = Pick<McpDeps, 'key' | 'store' | 'fetch' | 'now' | 'refreshes' | 'subscriptions' | 'publicHost'>;

const keyOf = (connector: string, agent: string, event: string): string => `${connector} ${agent} ${event}`;

export const callbackUrl = (publicHost: string, id: string): string => `https://${publicHost}${MCP_EVENTS_PATH}${id}`;

function due(row: SubscriptionRow, signedIn: string, now: number): boolean {
  if (row.serverId === null && row.signedIn === signedOutOf(signedIn)) return false;
  if (row.errorAt !== null && now - row.errorAt < RETRY_MS) return false;
  if (row.serverId === null || row.signedIn !== signedIn) return true;
  if (row.refreshBefore === null) return false;
  const span = Math.max(0, row.refreshBefore - (row.subscribedAt ?? now));
  return now >= row.refreshBefore - Math.min(REFRESH_EARLY_MS, span / 2);
}

function newRow(deps: SubscribeDeps, wanted: WantedSubscription): SubscriptionRow {
  const id = newId();
  const owner = wanted.connector.owner;
  return {
    id,
    owner,
    connector: wanted.connector.id,
    agent: wanted.identity.agent,
    event: wanted.event,
    secret: sealSecret(deps.key, owner, id, newWebhookSecret(), 'webhook'),
    serverId: null,
    cursor: null,
    refreshBefore: null,
    subscribedAt: null,
    signedIn: null,
    error: null,
    errorAt: null,
    createdAt: deps.now(),
  };
}

async function subscribe(deps: SubscribeDeps, wanted: WantedSubscription, row: SubscriptionRow): Promise<void> {
  const signedIn = signedInOf(wanted.connector);
  const fresh = row.signedIn !== null && row.signedIn !== signedIn ? { ...row, secret: sealSecret(deps.key, row.owner, row.id, newWebhookSecret(), 'webhook') } : row;
  if (fresh !== row) await deps.subscriptions.rekey(row.id, fresh.secret);
  const params = { name: row.event, arguments: {}, delivery: { mode: 'webhook', url: callbackUrl(deps.publicHost, row.id), secret: webhookSecretOf(deps.key, fresh) }, cursor: row.cursor, ttlMs: SUBSCRIPTION_TTL_MS };
  const now = deps.now();
  try {
    const result = await withCredential(deps, wanted.identity, wanted.connector.id, (target) => callVendorMethod(target, EVENTS_SUBSCRIBE, params, deps.fetch, SUBSCRIBE_MS));
    const answer = subscribeAnswerOf(result);
    await deps.subscriptions.subscribed(row.id, { serverId: answer.id, cursor: answer.cursor ?? row.cursor, refreshBefore: answer.refreshBefore, subscribedAt: now, signedIn });
    noteAnswer(row, answer);
  } catch (err) {
    if (err instanceof VendorRpcError && err.rpcCode === SIGNED_OUT_CODE) {
      await deps.subscriptions.ended(row.id, SIGNED_OUT_NOTE, now, signedOutOf(signedIn));
      log.info({ subscription: row.id, connector: row.connector }, 'mcp: the mailbox is signed out on the connector, so its mail waits for a new sign-in');
      return;
    }
    await deps.subscriptions.failed(row.id, errMsg(err), now);
    log.warn({ subscription: row.id, connector: row.connector, err: errMsg(err) }, 'mcp: could not subscribe to a connector\'s mail; trying again later');
  }
}

function noteAnswer(row: SubscriptionRow, answer: SubscribeAnswer): void {
  if (answer.truncated) log.warn({ subscription: row.id, connector: row.connector }, 'mcp: the connector skipped mail since the last cursor');
  if (!answer.delivering) log.warn({ subscription: row.id, connector: row.connector, lastError: answer.lastError }, 'mcp: the connector had stopped delivering mail; the refresh starts it again');
  log.info({ subscription: row.id, connector: row.connector, agent: row.agent, refresh: row.serverId !== null }, 'mcp: subscribed to a connector\'s mail');
}

async function unsubscribe(deps: SubscribeDeps, row: SubscriptionRow, connector: ConnectorRow | undefined): Promise<void> {
  try {
    if (connector !== undefined && row.serverId !== null) {
      const params = { name: row.event, arguments: {}, delivery: { url: callbackUrl(deps.publicHost, row.id) } };
      await callVendorMethod(targetOf(deps, connector), EVENTS_UNSUBSCRIBE, params, deps.fetch, SUBSCRIBE_MS);
    }
  } catch (err) {
    log.info({ subscription: row.id, err: errMsg(err) }, 'mcp: the connector did not take the unsubscribe, so the subscription lapses by itself');
  }
  await deps.subscriptions.remove(row.id);
  log.info({ subscription: row.id, connector: row.connector, agent: row.agent }, 'mcp: a mail subscription is no longer wanted');
}

type Held = () => Promise<boolean>;

const rowKey = (row: SubscriptionRow): string => keyOf(row.connector, row.agent, row.event);
const wantKey = (want: WantedSubscription): string => keyOf(want.connector.id, want.identity.agent, want.event);

async function dropUnwanted(deps: SubscribeDeps, unwanted: SubscriptionRow[], held: Held): Promise<number> {
  const connectors = await deps.subscriptions.connectors(unwanted.map((row) => row.connector));
  let steps = 0;
  for (const row of unwanted.slice(0, STEPS_MAX)) {
    if (!(await held())) break;
    await unsubscribe(deps, row, connectors.get(row.connector));
    steps += 1;
  }
  return steps;
}

async function keepWanted(deps: SubscribeDeps, wanted: WantedSubscription[], known: Map<string, SubscriptionRow>, budget: number, held: Held): Promise<number> {
  let steps = 0;
  for (const want of wanted) {
    if (steps >= budget) break;
    const row = known.get(wantKey(want)) ?? (await deps.subscriptions.open(newRow(deps, want)));
    if (!due(row, signedInOf(want.connector), deps.now())) continue;
    if (!(await held())) break;
    await subscribe(deps, want, row);
    steps += 1;
  }
  return steps;
}

export async function syncSubscriptions(deps: SubscribeDeps, held: Held = () => Promise.resolve(true)): Promise<number> {
  const [wanted, rows] = await Promise.all([deps.subscriptions.wanted(), deps.subscriptions.list()]);
  const wantedKeys = new Set(wanted.map(wantKey));
  const dropped = await dropUnwanted(deps, rows.filter((row) => !wantedKeys.has(rowKey(row))), held);
  return dropped + (await keepWanted(deps, wanted, new Map(rows.map((row) => [rowKey(row), row])), STEPS_MAX - dropped, held));
}

export function startSubscriptions(deps: SubscribeDeps, everyMs = TICK_MS): () => void {
  const holder = newId();
  let running = false;
  let quiet = false;
  const lease = (): Promise<boolean> => deps.subscriptions.lease(LEASE, holder, deps.now(), LEASE_MS);
  const tick = async (): Promise<void> => {
    if (!(await lease())) return;
    await syncSubscriptions(deps, lease);
    quiet = false;
  };
  const run = (): void => {
    if (running) return;
    running = true;
    tick()
      .catch((err: unknown) => {
        if (quiet) return;
        quiet = true;
        if (isUndefinedTable(err)) log.warn('mcp: the connector_subscriptions table does not exist yet, so mail subscriptions wait until api.metro.box migrates');
        else log.warn({ err: errMsg(err) }, 'mcp: mail subscriptions could not be checked, later failures stay quiet until one works');
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
