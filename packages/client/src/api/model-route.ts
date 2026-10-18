import { EFFORT_DEFAULTS, effortSet, readEffort, type EffortLevel, type RouteEffort } from '@metro-labs/core/effort';
import { isRecord, str } from '../read.js';

export { EFFORT_LEVELS, type EffortLevel, type RouteEffort } from '@metro-labs/core/effort';

export interface RouteStep {
  connection: string;
  model: string;
}

export interface RouteChain {
  primary: RouteStep;
  fallbacks: RouteStep[];
}

export interface ModelRoute extends RouteChain {
  helpers?: RouteChain | null;
  effort?: RouteEffort;
}

export type RouteSource = 'agent' | 'organization' | null;

export type EffortThread = keyof RouteEffort;

export const FALLBACKS_MAX = 8;

export const sameStep = (a: RouteStep, b: RouteStep): boolean => a.connection === b.connection && a.model === b.model;

export const toSource = (value: unknown): RouteSource => (value === 'agent' || value === 'organization' ? value : null);

export function toStep(raw: unknown): RouteStep | null {
  if (!isRecord(raw)) return null;
  const connection = str(raw.connection);
  return connection === '' ? null : { connection, model: str(raw.model) };
}

export function toFallbacks(raw: unknown): RouteStep[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item: unknown) => {
    const step = toStep(item);
    return step === null || step.model === '' ? [] : [step];
  });
}

function toChain(raw: unknown): RouteChain | null {
  if (!isRecord(raw)) return null;
  const primary = toStep(raw.primary);
  return primary === null ? null : { primary, fallbacks: toFallbacks(raw.fallbacks) };
}

export function toRoute(raw: unknown): ModelRoute | null {
  const main = toChain(raw);
  if (main === null || !isRecord(raw)) return null;
  const helpers = toChain(raw.helpers);
  const effort = readEffort(raw.effort);
  return { ...main, ...(helpers === null ? {} : { helpers }), ...(effortSet(effort) ? { effort } : {}) };
}

const chainSteps = (chain: RouteChain | null): RouteStep[] => (chain === null ? [] : [chain.primary, ...chain.fallbacks]);

export const routeSteps = (route: ModelRoute | null): RouteStep[] => [...chainSteps(route), ...chainSteps(route?.helpers ?? null)];

export const effortOf = (effort: RouteEffort | null | undefined, thread: EffortThread): EffortLevel => effort?.[thread] ?? EFFORT_DEFAULTS[thread];

export const withHelpers = (route: ModelRoute, helpers: RouteChain | null): ModelRoute => ({ ...route, helpers: helpers === null ? null : { primary: helpers.primary, fallbacks: helpers.fallbacks } });

export const withEffort = (route: ModelRoute, thread: EffortThread, level: EffortLevel): ModelRoute => ({ ...route, effort: { ...route.effort, [thread]: level } });
