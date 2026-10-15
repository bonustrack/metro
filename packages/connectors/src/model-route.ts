import { ID_RE } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { parsedJson } from './model.js';

export interface RouteTarget {
  connection: string;
  model: string;
}

export interface ModelRoute {
  primary: RouteTarget | null;
  fallbacks: RouteTarget[];
}

export const LOCAL_SESSION = 'local:session';
export const FALLBACKS_MAX = 8;
export const MODEL_ID_MAX = 512;

const LOCAL_PREFIX = 'local:';

export const isLocalRef = (ref: string): boolean => ref === LOCAL_SESSION || (ref.startsWith(LOCAL_PREFIX) && ID_RE.test(ref.slice(LOCAL_PREFIX.length)));

export const isRouteRef = (ref: string): boolean => ID_RE.test(ref) || isLocalRef(ref);

export const localLogin = (loginId: string): string => `${LOCAL_PREFIX}${loginId}`;

function targetOf(raw: unknown): RouteTarget | null {
  if (!isRecord(raw) || typeof raw.connection !== 'string' || typeof raw.model !== 'string') return null;
  return isRouteRef(raw.connection) && raw.model.length <= MODEL_ID_MAX ? { connection: raw.connection, model: raw.model } : null;
}

export function routeOf(text: string): ModelRoute {
  const value = parsedJson(text);
  if (!isRecord(value)) return { primary: null, fallbacks: [] };
  const fallbacks = Array.isArray(value.fallbacks) ? value.fallbacks.flatMap((raw: unknown) => targetOf(raw) ?? []) : [];
  return { primary: targetOf(value.primary), fallbacks: fallbacks.slice(0, FALLBACKS_MAX) };
}

export const routeText = (route: ModelRoute): string => JSON.stringify({ primary: route.primary, fallbacks: route.fallbacks });

export function routeNames(route: ModelRoute): string[] {
  const named = [route.primary?.connection, ...route.fallbacks.map((f) => f.connection)].filter((ref): ref is string => ref !== undefined);
  return [...new Set(named)];
}

export const orgConnectionsOf = (route: ModelRoute): string[] => routeNames(route).filter((ref) => !isLocalRef(ref));

export function withoutConnection(route: ModelRoute, id: string): ModelRoute {
  return { primary: route.primary?.connection === id ? null : route.primary, fallbacks: route.fallbacks.filter((f) => f.connection !== id) };
}

export function distinctFallbacks(fallbacks: RouteTarget[]): RouteTarget[] {
  return fallbacks.filter((f, at) => fallbacks.findIndex((o) => o.connection === f.connection && o.model === f.model) === at).slice(0, FALLBACKS_MAX);
}
