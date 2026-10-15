import { isRecord, str } from '../read.js';

export interface RouteStep {
  connection: string;
  model: string;
}

export interface ModelRoute {
  primary: RouteStep;
  fallbacks: RouteStep[];
}

export type RouteSource = 'agent' | 'organization' | null;

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

export function toRoute(raw: unknown): ModelRoute | null {
  if (!isRecord(raw)) return null;
  const primary = toStep(raw.primary);
  return primary === null ? null : { primary, fallbacks: toFallbacks(raw.fallbacks) };
}

export const routeSteps = (route: ModelRoute | null): RouteStep[] => (route === null ? [] : [route.primary, ...route.fallbacks]);
