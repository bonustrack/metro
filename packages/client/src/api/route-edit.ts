import { chooseConnection, saveConnection, saveFallbacks, type ConnectionRow, type Fallback, type ModelSettings } from './model.js';

export type Slot = { kind: 'primary' } | { kind: 'fallback'; at: number } | { kind: 'new' };

export interface RouteDraft {
  connection: string;
  model: string;
  zdr: boolean;
}

export interface RouteChange {
  label: string;
  from: string;
  to: string;
}

type Name = (connection: string, model: string) => string;

const NAMED_ONLY: ConnectionRow['provider'][] = ['openrouter', 'codex', 'gemini'];

export const sameRoute = (a: Fallback, b: Fallback): boolean => a.connection === b.connection && a.model === b.model;

const connectionOf = (settings: ModelSettings, id: string): ConnectionRow | undefined => settings.connections.find((c) => c.id === id);

export const slotTitle = (slot: Slot): string => (slot.kind === 'primary' ? 'Primary model' : slot.kind === 'new' ? 'Add a fallback' : `Fallback ${String(slot.at + 1)}`);

const EMPTY: Fallback = { connection: '', model: '' };

function routedOf(settings: ModelSettings): Fallback {
  const routed = connectionOf(settings, settings.route) ?? settings.connections[0];
  return routed === undefined ? EMPTY : { connection: routed.id, model: routed.model };
}

function startOf(settings: ModelSettings, slot: Slot): Fallback {
  if (slot.kind === 'fallback') return settings.fallbacks?.[slot.at] ?? EMPTY;
  return slot.kind === 'new' ? EMPTY : routedOf(settings);
}

export function draftOf(settings: ModelSettings, slot: Slot): RouteDraft {
  const start = startOf(settings, slot);
  return { ...start, zdr: connectionOf(settings, start.connection)?.zdr === true };
}

export function withConnection(settings: ModelSettings, id: string): RouteDraft {
  const conn = connectionOf(settings, id);
  return { connection: id, model: conn?.model ?? '', zdr: conn?.zdr === true };
}

const onOff = (on: boolean): string => (on ? 'on' : 'off');

function connectionChange(before: ConnectionRow | undefined, after: ConnectionRow | undefined): RouteChange[] {
  if (after === undefined || before?.id === after.id) return [];
  return [{ label: 'Connection', from: before?.label ?? 'none', to: after.label }];
}

function zdrChange(after: ConnectionRow | undefined, draft: RouteDraft): RouteChange[] {
  if (after?.provider !== 'openrouter' || after.zdr === draft.zdr) return [];
  return [{ label: 'Zero data retention', from: onOff(after.zdr), to: onOff(draft.zdr) }];
}

export function changesOf(settings: ModelSettings, slot: Slot, draft: RouteDraft, name: Name): RouteChange[] {
  const after = connectionOf(settings, draft.connection);
  if (after === undefined) return [];
  if (slot.kind === 'new') return draft.model === '' ? [] : [{ label: 'New fallback', from: '', to: `${name(draft.connection, draft.model)} on ${after.label}` }, ...zdrChange(after, draft)];
  const start = startOf(settings, slot);
  const before = connectionOf(settings, start.connection);
  const model = start.model !== draft.model || before?.id !== after.id ? [{ label: 'Model', from: name(start.connection, start.model), to: name(draft.connection, draft.model) }] : [];
  return [...connectionChange(before, after), ...model, ...zdrChange(after, draft)];
}

const others = (settings: ModelSettings, slot: Slot): Fallback[] => {
  const list = (settings.fallbacks ?? []).filter((_, at) => slot.kind !== 'fallback' || at !== slot.at);
  const routed = connectionOf(settings, settings.route);
  return slot.kind === 'primary' || routed === undefined ? list : [{ connection: routed.id, model: routed.model }, ...list];
};

function modelProblem(conn: ConnectionRow, slot: Slot, model: string): string | null {
  if (model !== '') return null;
  if (slot.kind !== 'primary') return 'Choose a named model for a fallback.';
  return NAMED_ONLY.includes(conn.provider) ? 'Choose a model.' : null;
}

function zdrProblem(conn: ConnectionRow, draft: RouteDraft, zdrModels: Set<string> | null): string | null {
  const checked = conn.provider === 'openrouter' && draft.zdr && zdrModels !== null && draft.model !== '';
  return checked && !(zdrModels?.has(draft.model) ?? false) ? `${draft.model} has no zero data retention endpoint. Pick another model or turn zero data retention off.` : null;
}

export function problemOf(settings: ModelSettings, slot: Slot, draft: RouteDraft, zdrModels: Set<string> | null): string | null {
  const conn = connectionOf(settings, draft.connection);
  if (conn === undefined) return 'Choose a connection.';
  const duplicate = slot.kind !== 'primary' && others(settings, slot).some((f) => sameRoute(f, draft));
  return modelProblem(conn, slot, draft.model) ?? (duplicate ? 'This model is already in the list.' : zdrProblem(conn, draft, zdrModels));
}

export function fallbacksAfter(settings: ModelSettings, slot: Slot, draft: RouteDraft): Fallback[] {
  const list = settings.fallbacks ?? [];
  const pick = { connection: draft.connection, model: draft.model };
  if (slot.kind === 'new') return [...list, pick];
  return slot.kind === 'fallback' ? list.map((f, at) => (at === slot.at ? pick : f)) : list;
}

export async function saveRoute(settings: ModelSettings, slot: Slot, draft: RouteDraft): Promise<void> {
  const conn = connectionOf(settings, draft.connection);
  if (conn === undefined) throw new Error('Choose a connection.');
  const zdr = conn.provider === 'openrouter' && conn.zdr !== draft.zdr ? { zdr: draft.zdr } : {};
  if (slot.kind !== 'primary') {
    if ('zdr' in zdr) await saveConnection(conn.id, zdr);
    await saveFallbacks(fallbacksAfter(settings, slot, draft));
    return;
  }
  if (conn.model !== draft.model || 'zdr' in zdr) await saveConnection(conn.id, { model: draft.model, ...zdr });
  if (settings.route !== conn.id) await chooseConnection(conn.id);
}

export function movedFallbacks(list: Fallback[], at: number, by: number): Fallback[] {
  const next = [...list];
  const [item] = next.splice(at, 1);
  if (item === undefined) return list;
  next.splice(Math.min(next.length, Math.max(0, at + by)), 0, item);
  return next;
}

export function promotedFallbacks(settings: ModelSettings, at: number): Fallback[] {
  const list = settings.fallbacks ?? [];
  const rest = list.filter((_, other) => other !== at);
  const routed = connectionOf(settings, settings.route);
  const old = routed === undefined ? null : { connection: routed.id, model: routed.model !== '' ? routed.model : (settings.chain[0]?.model ?? '') };
  if (old === null || old.model === '' || rest.some((f) => sameRoute(f, old))) return rest;
  return [...rest.slice(0, at), old, ...rest.slice(at)];
}

export async function promoteFallback(settings: ModelSettings, at: number): Promise<void> {
  const picked = settings.fallbacks?.[at];
  if (picked === undefined) return;
  await saveFallbacks(promotedFallbacks(settings, at));
  await saveConnection(picked.connection, { model: picked.model });
  if (settings.route !== picked.connection) await chooseConnection(picked.connection);
}

export function sharesConnection(settings: ModelSettings, slot: Slot, id: string): boolean {
  const primary = slot.kind !== 'primary' && settings.route === id;
  return primary || (settings.fallbacks ?? []).some((f, at) => f.connection === id && (slot.kind !== 'fallback' || at !== slot.at));
}
