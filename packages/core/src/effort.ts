import { isRecord } from './is-record.js';

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'max', 'asked'] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export interface RouteEffort {
  main?: EffortLevel;
  helpers?: EffortLevel;
}

export const EFFORT_DEFAULTS: Required<RouteEffort> = { main: 'low', helpers: 'max' };

export const isEffortLevel = (value: unknown): value is EffortLevel => typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value);

export function readEffort(raw: unknown): RouteEffort {
  if (!isRecord(raw)) return {};
  return { ...(isEffortLevel(raw.main) ? { main: raw.main } : {}), ...(isEffortLevel(raw.helpers) ? { helpers: raw.helpers } : {}) };
}

export const effortSet = (effort: RouteEffort): boolean => effort.main !== undefined || effort.helpers !== undefined;
