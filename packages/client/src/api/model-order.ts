import type { ChainRow, ConnectionRow, ModelSettings } from './model.js';
import { sameRoute, type Slot } from './route-edit.js';
import { usageModel } from './model-usage.js';

export interface ModelOrderItem {
  slot: Slot;
  connection: ConnectionRow | undefined;
  model: string;
  row: ChainRow | undefined;
  usage: ModelSettings['usage'][string] | undefined;
  passthrough: boolean;
}

export function modelOrder(settings: ModelSettings): ModelOrderItem[] {
  const connection = settings.connections.find((c) => c.id === settings.route);
  const passthrough = settings.route === '';
  const id = passthrough ? 'passthrough' : settings.route;
  const head = settings.chain.find((r) => r.connection === id);
  const primary: ModelOrderItem = {
    slot: { kind: 'primary' }, connection, passthrough,
    model: usageModel(settings, connection),
    row: head ?? (passthrough ? { connection: id, model: '', used: null, hold: null, active: true } : undefined),
    usage: connection === undefined && !passthrough ? undefined : settings.usage[id],
  };
  return [primary, ...(settings.fallbacks ?? []).map((f, at): ModelOrderItem => {
    const conn = settings.connections.find((c) => c.id === f.connection);
    return {
      slot: { kind: 'fallback', at }, connection: conn, model: f.model, passthrough: false,
      row: settings.chain.find((r) => r !== head && sameRoute(r, f)),
      usage: conn === undefined ? undefined : settings.usage[conn.id],
    };
  })];
}

export function modelAccount(item: ModelOrderItem, login: string | null): string {
  const conn = item.connection;
  if (conn === undefined) return item.passthrough ? (login ?? 'Account not reported') : 'Connection unavailable';
  const own = conn.provider === 'anthropic' && !conn.hasKey && !conn.signedIn;
  return conn.account ?? (own ? login : null) ?? (conn.hasKey ? 'API key' : 'Account not reported');
}
