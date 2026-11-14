import { errMsg } from '@metro-labs/core/log';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { deliversByWebhook, listRemoteEvents } from '@metro-labs/http/connector-tools';
import { declaresEvents, EVENTS_LIST, EVENTS_SUBSCRIBE, EVENTS_UNSUBSCRIBE, subscribeParams, subscribeResultOf, unsubscribeParams, type SenderPointers, type SubscribeRequest, type SubscribeResult } from '@metro-labs/http/mcp-events';
import type { VendorTarget } from './credential.js';
import { withVendorSession, type VendorSession } from './vendor.js';

const EVENTS_CALL_MS = 30_000;

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

function checkDeclared(session: VendorSession): void {
  if (!declaresEvents(session.initialize)) throw new EventsRefused('This connector does not offer events.');
}

export function subscribeTo(target: VendorTarget, fetch: FetchLike, request: SubscribeRequest): Promise<Subscribed> {
  return withVendorSession(target, fetch, async (session) => {
    checkDeclared(session);
    const event = (await listRemoteEvents((params) => session.request(EVENTS_LIST, params, routed(EVENTS_LIST)))).find((offered) => offered.name === request.name);
    if (event === undefined) throw new EventsRefused(`This connector no longer offers ${request.name}.`);
    if (!deliversByWebhook(event)) throw new EventsRefused(`This connector cannot send ${request.name} to Metro (it offers no webhook delivery).`);
    const result = await session.request(EVENTS_SUBSCRIBE, subscribeParams(request), routed(EVENTS_SUBSCRIBE, request.name));
    return { result: answered(result), sender: event.sender ?? null };
  });
}

export function unsubscribeFrom(target: VendorTarget, fetch: FetchLike, name: string, url: string): Promise<void> {
  return withVendorSession(target, fetch, async (session) => {
    checkDeclared(session);
    await session.request(EVENTS_UNSUBSCRIBE, unsubscribeParams(name, url), routed(EVENTS_UNSUBSCRIBE, name));
  });
}
