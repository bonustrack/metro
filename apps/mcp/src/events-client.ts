import { errMsg } from '@metro-labs/core/log';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { deliversByWebhook, remoteEventOf, type RemoteEvent } from '@metro-labs/http/connector-tools';
import { declaresEvents, EVENTS_LIST, EVENTS_SUBSCRIBE, EVENTS_UNSUBSCRIBE, subscribeParams, subscribeResultOf, unsubscribeParams, type SenderPointers, type SubscribeResult } from '@metro-labs/http/mcp-events';
import type { VendorTarget } from './credential.js';
import { withVendorSession, type VendorSession } from './vendor.js';

const EVENTS_CALL_MS = 30_000;
const LIST_PAGES = 10;

export interface SubscribeRequest {
  name: string;
  url: string;
  secret: string;
  cursor: string | null;
  ttlMs: number;
}

export interface Subscribed {
  result: SubscribeResult;
  sender: SenderPointers | null;
}

export class EventsRefused extends Error {}

function answered(result: Record<string, unknown>): SubscribeResult {
  try {
    return subscribeResultOf(result);
  } catch (err) {
    throw new EventsRefused(errMsg(err));
  }
}

const routed = (method: string, name?: string): { timeoutMs: number; headers: Record<string, string> } => ({ timeoutMs: EVENTS_CALL_MS, headers: { 'mcp-method': method, ...(name === undefined ? {} : { 'mcp-name': name }) } });

async function offered(session: VendorSession, name: string): Promise<RemoteEvent | null> {
  let cursor = '';
  for (let page = 0; page < LIST_PAGES; page += 1) {
    const result = await session.request(EVENTS_LIST, cursor === '' ? {} : { cursor }, routed(EVENTS_LIST));
    const events = Array.isArray(result.events) ? result.events.map(remoteEventOf) : [];
    const found = events.find((event) => event?.name === name);
    if (found !== undefined && found !== null) return found;
    const next = result.nextCursor;
    if (typeof next !== 'string' || next === '' || next === cursor) return null;
    cursor = next;
  }
  return null;
}

function checkDeclared(session: VendorSession): void {
  if (!declaresEvents(session.initialize)) throw new EventsRefused('This connector does not offer events.');
}

export function subscribeTo(target: VendorTarget, fetch: FetchLike, request: SubscribeRequest): Promise<Subscribed> {
  return withVendorSession(target, fetch, async (session) => {
    checkDeclared(session);
    const event = await offered(session, request.name);
    if (event === null) throw new EventsRefused(`This connector no longer offers ${request.name}.`);
    if (!deliversByWebhook(event)) throw new EventsRefused(`This connector cannot send ${request.name} to Metro (it offers no webhook delivery).`);
    const result = await session.request(EVENTS_SUBSCRIBE, subscribeParams(request.name, request.url, request.secret, request.cursor, request.ttlMs), routed(EVENTS_SUBSCRIBE, request.name));
    return { result: answered(result), sender: event.sender ?? null };
  });
}

export function unsubscribeFrom(target: VendorTarget, fetch: FetchLike, name: string, url: string): Promise<void> {
  return withVendorSession(target, fetch, async (session) => {
    checkDeclared(session);
    await session.request(EVENTS_UNSUBSCRIBE, unsubscribeParams(name, url), routed(EVENTS_UNSUBSCRIBE, name));
  });
}
