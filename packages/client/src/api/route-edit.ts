import type { ConnectionRow } from './model.js';
import type { ModelOption } from './model-options.js';
import { FALLBACKS_MAX, isLocal, sameStep, type ModelRoute, type RouteStep } from './model-route.js';

export type Slot = { kind: 'primary' } | { kind: 'fallback'; at: number } | { kind: 'new' };

export interface RouteChange {
  label: string;
  from: string;
  to: string;
}

type Name = (connection: string, model: string) => string;

const EMPTY: RouteStep = { connection: '', model: '' };

const connectionOf = (connections: ConnectionRow[], id: string): ConnectionRow | undefined => connections.find((c) => c.id === id);

export const slotTitle = (slot: Slot): string => (slot.kind === 'primary' ? 'Primary model' : slot.kind === 'new' ? 'Add a fallback' : `Fallback ${String(slot.at + 1)}`);

export function draftOf(route: ModelRoute | null, slot: Slot): RouteStep {
  if (slot.kind === 'fallback') return route?.fallbacks[slot.at] ?? EMPTY;
  return slot.kind === 'new' ? EMPTY : (route?.primary ?? EMPTY);
}

export const withConnection = (connections: ConnectionRow[], id: string): RouteStep => ({ connection: id, model: connectionOf(connections, id)?.model ?? '' });

function slotChanges(start: RouteStep, before: ConnectionRow | undefined, after: ConnectionRow, draft: RouteStep, name: Name): RouteChange[] {
  const moved = before?.id !== after.id;
  const connection = moved ? [{ label: 'Connection', from: before?.label ?? 'none', to: after.label }] : [];
  const from = start.connection === '' ? 'none' : name(start.connection, start.model);
  const model = moved || start.model !== draft.model ? [{ label: 'Model', from, to: name(draft.connection, draft.model) }] : [];
  return [...connection, ...model];
}

export function changesOf(route: ModelRoute | null, connections: ConnectionRow[], slot: Slot, draft: RouteStep, name: Name): RouteChange[] {
  const after = connectionOf(connections, draft.connection);
  if (after === undefined) return [];
  if (slot.kind === 'new') return draft.model === '' ? [] : [{ label: 'New fallback', from: '', to: `${name(draft.connection, draft.model)} on ${after.label}` }];
  const start = draftOf(route, slot);
  return slotChanges(start, connectionOf(connections, start.connection), after, draft, name);
}

function others(route: ModelRoute | null, slot: Slot): RouteStep[] {
  if (route === null) return [];
  const list = route.fallbacks.filter((_, at) => slot.kind !== 'fallback' || at !== slot.at);
  return slot.kind === 'primary' ? list : [route.primary, ...list];
}

function modelProblem(conn: ConnectionRow, slot: Slot, model: string): string | null {
  if (model !== '') return null;
  if (slot.kind !== 'primary') return 'Choose a named model for a fallback.';
  return isLocal(conn.id) ? null : 'Choose a model.';
}

function zdrProblem(conn: ConnectionRow, model: string, models: ModelOption[]): string | null {
  const refused = conn.provider === 'openrouter' && conn.zdr && models.find((m) => m.id === model)?.zdr === false;
  return refused ? `${model} has no zero data retention endpoint. Pick another model, or turn zero data retention off on the ${conn.label} connection.` : null;
}

export function problemOf(route: ModelRoute | null, connections: ConnectionRow[], slot: Slot, draft: RouteStep, models: ModelOption[] = []): string | null {
  const conn = connectionOf(connections, draft.connection);
  if (conn === undefined) return 'Choose a connection.';
  const duplicate = slot.kind !== 'primary' && others(route, slot).some((step) => sameStep(step, draft));
  return modelProblem(conn, slot, draft.model) ?? (duplicate ? 'This model is already in the list.' : zdrProblem(conn, draft.model, models));
}

export function routeAfter(route: ModelRoute | null, slot: Slot, draft: RouteStep): ModelRoute {
  const step = { connection: draft.connection, model: draft.model };
  if (route === null || slot.kind === 'primary') return { primary: step, fallbacks: route?.fallbacks ?? [] };
  if (slot.kind === 'new') return { ...route, fallbacks: [...route.fallbacks, step] };
  return { ...route, fallbacks: route.fallbacks.map((f, at) => (at === slot.at ? step : f)) };
}

export const canAddFallback = (route: ModelRoute | null): boolean => route !== null && route.fallbacks.length < FALLBACKS_MAX;

export function movedFallback(route: ModelRoute, at: number, by: number): ModelRoute {
  const next = [...route.fallbacks];
  const [item] = next.splice(at, 1);
  if (item === undefined) return route;
  next.splice(Math.min(next.length, Math.max(0, at + by)), 0, item);
  return { ...route, fallbacks: next };
}

export const removedFallback = (route: ModelRoute, at: number): ModelRoute => ({ ...route, fallbacks: route.fallbacks.filter((_, other) => other !== at) });

export function promotedFallback(route: ModelRoute, at: number, primaryModel = route.primary.model): ModelRoute {
  const picked = route.fallbacks[at];
  if (picked === undefined) return route;
  const rest = route.fallbacks.filter((_, other) => other !== at);
  const old = { connection: route.primary.connection, model: primaryModel };
  const keep = old.model !== '' && !rest.some((step) => sameStep(step, old)) && !sameStep(old, picked);
  return { primary: picked, fallbacks: keep ? [...rest.slice(0, at), old, ...rest.slice(at)] : rest };
}
