import { usageOf, type ChainRow, type ConnectionRow, type ModelSettings } from './model.js';
import { LOCAL_SESSION, sameStep, type ModelRoute, type RouteStep } from './model-route.js';
import type { Slot } from './route-edit.js';
import { usageModel } from './model-usage.js';
import { usesSessionLogin } from './providers.js';

export interface ModelOrderItem {
  slot: Slot;
  step: RouteStep;
  connection: ConnectionRow | undefined;
  model: string;
  row: ChainRow | undefined;
  usage: ModelSettings['usage'][string] | undefined;
}

const SESSION_ROUTE: ModelRoute = { primary: { connection: LOCAL_SESSION, model: '' }, fallbacks: [] };

export const effectiveRoute = (settings: ModelSettings): ModelRoute => settings.route ?? SESSION_ROUTE;

export function modelOrder(settings: ModelSettings): ModelOrderItem[] {
  const route = effectiveRoute(settings);
  const find = (id: string): ConnectionRow | undefined => settings.connections.find((c) => c.id === id);
  const usage = (conn: ConnectionRow | undefined): ModelOrderItem['usage'] => (conn === undefined ? undefined : usageOf(settings, conn.id));
  const head = settings.chain.find((r) => r.connection === route.primary.connection);
  const lead = find(route.primary.connection);
  const session = route.primary.connection === LOCAL_SESSION;
  const primary: ModelOrderItem = {
    slot: { kind: 'primary' }, step: route.primary, connection: lead,
    model: usageModel(settings, route.primary),
    row: head ?? (session ? { connection: LOCAL_SESSION, model: '', used: null, hold: null, active: true } : undefined),
    usage: usage(lead),
  };
  return [primary, ...route.fallbacks.map((step, at): ModelOrderItem => {
    const conn = find(step.connection);
    return { slot: { kind: 'fallback', at }, step, connection: conn, model: step.model, row: settings.chain.find((r) => r !== head && sameStep(r, step)), usage: usage(conn) };
  })];
}

export function routeItems(route: ModelRoute, connections: ConnectionRow[]): ModelOrderItem[] {
  return [route.primary, ...route.fallbacks].map((step, at): ModelOrderItem => ({
    slot: at === 0 ? { kind: 'primary' } : { kind: 'fallback', at: at - 1 },
    step,
    connection: connections.find((c) => c.id === step.connection),
    model: step.model,
    row: undefined,
    usage: undefined,
  }));
}

export function modelAccount(item: ModelOrderItem, login: string | null): string {
  const conn = item.connection;
  if (conn === undefined) return 'Connection unavailable';
  if (usesSessionLogin(conn)) return login ?? 'Account not reported';
  return conn.account ?? (conn.hasKey ? 'API key' : 'Account not reported');
}
