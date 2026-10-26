import { filled, isRecord } from '../read.js';
import { builtInDaemon } from '../auth/daemon.js';
import { NotFoundError } from './client.js';
import { orgCall } from './org-connectors.js';

export interface ActivityCall {
  id: string;
  agent: string;
  agentName: string | null;
  connector: string | null;
  connectorKey: string;
  connectorName: string | null;
  connectorUrl: string | null;
  tool: string;
  outcome: string;
  ms: number;
  at: number;
}

interface ActivityQuery {
  since?: number;
  before?: ActivityCall;
  limit: number;
  agent?: string | null;
  connector?: string | null;
}

export interface ActivityFeed {
  calls: ActivityCall[];
  pending: ActivityCall[];
  held: boolean;
  loaded: boolean;
  complete: boolean;
  cap: number;
}

type FeedAction =
  | { type: 'newer'; calls: ActivityCall[] | null }
  | { type: 'older'; calls: ActivityCall[] | null; asked: number }
  | { type: 'hold'; held: boolean };

export const ACTIVITY_PAGE = 50;
export const ACTIVITY_LIVE_MAX = 200;
export const ACTIVITY_LATE_MS = 10_000;

const unexpected = (): Error => new Error('Metro returned an unexpected response.');
const number = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export function toActivityCall(value: unknown): ActivityCall | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.agent !== 'string' || typeof value.tool !== 'string') return null;
  const at = number(value.at);
  if (at === null) return null;
  return {
    id: value.id,
    agent: value.agent,
    agentName: filled(value.agentName),
    connector: filled(value.connector),
    connectorKey: typeof value.connectorKey === 'string' ? value.connectorKey : '',
    connectorName: filled(value.connectorName),
    connectorUrl: filled(value.connectorUrl),
    tool: value.tool,
    outcome: typeof value.outcome === 'string' ? value.outcome : '',
    ms: Math.max(0, number(value.ms) ?? 0),
    at,
  };
}

function activityPath(query: ActivityQuery): string {
  const params = new URLSearchParams({ limit: String(query.limit) });
  if (query.since !== undefined) params.set('since', String(Math.max(0, Math.floor(query.since))));
  if (query.before !== undefined) params.set('before', `${String(query.before.at)}:${query.before.id}`);
  if (query.agent !== undefined && query.agent !== null) params.set('agent', query.agent);
  if (query.connector !== undefined && query.connector !== null) params.set('connector', query.connector);
  return `/activity?${params.toString()}`;
}

export async function fetchConnectorActivity(query: ActivityQuery, signal?: AbortSignal): Promise<ActivityCall[] | null> {
  try {
    const body = await orgCall({ method: 'GET', base: `${builtInDaemon()}/api/connectors`, path: activityPath(query), signal });
    if (!isRecord(body) || !Array.isArray(body.calls)) throw unexpected();
    return body.calls.map(toActivityCall).filter((call): call is ActivityCall => call !== null);
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
}

const newerFirst = (a: ActivityCall, b: ActivityCall): number => (a.at !== b.at ? b.at - a.at : a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

function merged(held: ActivityCall[], incoming: ActivityCall[]): ActivityCall[] {
  const byId = new Map(held.map((call) => [call.id, call]));
  for (const call of incoming) byId.set(call.id, call);
  return [...byId.values()].sort(newerFirst);
}

export const emptyFeed = (): ActivityFeed => ({ calls: [], pending: [], held: false, loaded: false, complete: false, cap: ACTIVITY_LIVE_MAX });

function trimmed(feed: ActivityFeed, calls: ActivityCall[]): ActivityFeed {
  if (calls.length <= feed.cap) return { ...feed, calls };
  return { ...feed, calls: calls.slice(0, feed.cap), complete: false };
}

function newer(feed: ActivityFeed, page: ActivityCall[] | null): ActivityFeed {
  if (!feed.loaded) return { ...feed, calls: merged([], page ?? []).slice(0, feed.cap), loaded: true, complete: page === null || page.length < ACTIVITY_PAGE };
  const known = new Set([...feed.calls, ...feed.pending].map((call) => call.id));
  const fresh = (page ?? []).filter((call) => !known.has(call.id));
  if (fresh.length === 0) return feed;
  if (feed.held) return { ...feed, pending: merged(feed.pending, fresh).slice(0, ACTIVITY_LIVE_MAX) };
  return trimmed(feed, merged(feed.calls, fresh));
}

function older(feed: ActivityFeed, page: ActivityCall[] | null, asked: number): ActivityFeed {
  const calls = merged(feed.calls, page ?? []);
  return { ...feed, calls, cap: Math.max(feed.cap, calls.length), complete: page === null || page.length < asked };
}

function hold(feed: ActivityFeed, held: boolean): ActivityFeed {
  if (held) return feed.held ? feed : { ...feed, held: true };
  return trimmed({ ...feed, held: false, pending: [] }, merged(feed.calls, feed.pending));
}

export function feedReducer(feed: ActivityFeed, action: FeedAction): ActivityFeed {
  if (action.type === 'newer') return newer(feed, action.calls);
  if (action.type === 'older') return older(feed, action.calls, action.asked);
  return hold(feed, action.held);
}

export function feedSince(feed: ActivityFeed): number | undefined {
  if (!feed.loaded) return undefined;
  const newest = Math.max(0, ...feed.calls.map((call) => call.at), ...feed.pending.map((call) => call.at));
  return Math.max(0, newest - ACTIVITY_LATE_MS);
}

export const oldestCall = (feed: ActivityFeed): ActivityCall | undefined => feed.calls.at(-1);
