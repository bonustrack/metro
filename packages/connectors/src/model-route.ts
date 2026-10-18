import { effortSet, readEffort, type RouteEffort } from '@metro-labs/core/effort';
import { ID_RE } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { parsedJson } from './model.js';

export interface RouteTarget {
  connection: string;
  model: string;
}

export interface RouteChain {
  primary: RouteTarget;
  fallbacks: RouteTarget[];
}

export interface ModelRoute extends RouteChain {
  helpers?: RouteChain;
  effort?: RouteEffort;
}

export const FALLBACKS_MAX = 8;
export const MODEL_ID_MAX = 512;

function targetOf(raw: unknown): RouteTarget | null {
  if (!isRecord(raw) || typeof raw.connection !== 'string' || typeof raw.model !== 'string') return null;
  return ID_RE.test(raw.connection) && raw.model.length <= MODEL_ID_MAX ? { connection: raw.connection, model: raw.model } : null;
}

function chainFrom(primary: RouteTarget | null, fallbacks: RouteTarget[]): RouteChain | null {
  const [first, ...rest] = primary === null ? fallbacks : [primary, ...fallbacks];
  return first === undefined ? null : { primary: first, fallbacks: rest.slice(0, FALLBACKS_MAX) };
}

function chainOf(value: unknown): RouteChain | null {
  if (!isRecord(value)) return null;
  const fallbacks = Array.isArray(value.fallbacks) ? value.fallbacks.flatMap((raw: unknown) => targetOf(raw) ?? []) : [];
  return chainFrom(targetOf(value.primary), fallbacks);
}

export function withParts(main: RouteChain, helpers: RouteChain | null, effort: RouteEffort | null): ModelRoute {
  const route: ModelRoute = { primary: main.primary, fallbacks: main.fallbacks };
  if (helpers !== null) route.helpers = { primary: helpers.primary, fallbacks: helpers.fallbacks };
  if (effort !== null && effortSet(effort)) route.effort = readEffort(effort);
  return route;
}

export function routeOf(text: string): ModelRoute | null {
  const value = parsedJson(text);
  const main = chainOf(value);
  if (main === null || !isRecord(value)) return null;
  return withParts(main, chainOf(value.helpers), readEffort(value.effort));
}

export const routeText = (route: ModelRoute): string => JSON.stringify(withParts(route, route.helpers ?? null, route.effort ?? null));

const chainNames = (chain: RouteChain): string[] => [chain.primary.connection, ...chain.fallbacks.map((f) => f.connection)];

export function routeNames(route: ModelRoute): string[] {
  return [...new Set([...chainNames(route), ...(route.helpers === undefined ? [] : chainNames(route.helpers))])];
}

const chainWithout = (chain: RouteChain, id: string): RouteChain | null =>
  chainFrom(chain.primary.connection === id ? null : chain.primary, chain.fallbacks.filter((f) => f.connection !== id));

export function withoutConnection(route: ModelRoute, id: string): ModelRoute | null {
  const main = chainWithout(route, id);
  if (main === null) return null;
  return withParts(main, route.helpers === undefined ? null : chainWithout(route.helpers, id), route.effort ?? null);
}

export function distinctFallbacks(fallbacks: RouteTarget[]): RouteTarget[] {
  return fallbacks.filter((f, at) => fallbacks.findIndex((o) => o.connection === f.connection && o.model === f.model) === at).slice(0, FALLBACKS_MAX);
}
