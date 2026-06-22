import type { MetroEvent } from './events.js';
import { Line } from './lines.js';
import type { ClaimsMap } from './claims.js';

export type BusListener = (event: MetroEvent) => void;

const RING_CAP = 500;

const listeners = new Set<BusListener>();
const ring: MetroEvent[] = [];

export function publishEvent(event: MetroEvent): void {
  ring.push(event);
  if (ring.length > RING_CAP) ring.shift();
  for (const fn of [...listeners]) {
    try {
      fn(event);
    } catch {
    }
  }
}

export function subscribeEvents(fn: BusListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function recentEvents(limit: number): MetroEvent[] {
  const n = Math.max(0, Math.min(limit, ring.length));
  return ring.slice(ring.length - n).reverse();
}

export type Mode = 'all' | 'mine-or-unclaimed' | 'mine-only' | 'unclaimed';

export function passesMode(
  event: MetroEvent,
  mode: Mode,
  self: Line | null,
  claims: ClaimsMap,
  opts: { includeWebhooks?: boolean } = {},
): boolean {
  if (self && event.to === self) return true;
  if (mode === 'all') return true;
  const isWebhook = event.station === 'webhook';
  if (mode === 'unclaimed') return !claims[event.line];
  if (isWebhook && !opts.includeWebhooks) return false;
  const owner = claims[event.line];
  if (mode === 'mine-only') return owner === self;
  return !owner || owner === self;
}

export interface TailOpts {
  mode: Mode;
  self: Line | null;
  chatFilter?: string;
  stationFilter?: string;
  includeWebhooks?: boolean;
  excludeFrom?: string[];
}

export function tailIncludes(
  entry: MetroEvent,
  opts: TailOpts,
  claims: ClaimsMap,
): boolean {
  if (opts.chatFilter && entry.line !== opts.chatFilter) return false;
  if (opts.stationFilter && entry.station !== opts.stationFilter) return false;
  if (opts.excludeFrom?.includes(entry.from)) return false;
  return passesMode(entry, opts.mode, opts.self, claims, {
    includeWebhooks: opts.includeWebhooks,
  });
}
