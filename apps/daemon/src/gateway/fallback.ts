import { log } from '@metro-labs/core/log';
import { lastServed } from './served.js';
import { PER_MINUTE, usageOf, type UsageWindow } from './usage.js';
import { bareModel, connectionOf, isSmallModel, notReady, routedConnection, routeLabel, type Connection, type Fallback, type ModelConfig, type Route } from './model-config.js';

export const USAGE_LIMIT = 0.95;
const COOLDOWN_MS = 60_000;
const SCOPED = 'Weekly, ';
const MS_PER_SECOND = 1000;

export interface Hold {
  reason: string;
  until: string | null;
}

interface Cooling {
  until: number;
  reason: string;
}

const cooling = new Map<string, Cooling>();
let lastChoice = '';

const keyOf = (route: Route): string => `${route.connection.id}\n${route.model}`;

export function forgetFallbackState(): void {
  cooling.clear();
  lastChoice = '';
}

function scopeOf(label: string): string | null {
  if (!label.startsWith(SCOPED) || label === 'Weekly, all models') return null;
  return (label.slice(SCOPED.length).trim().split(/\s+/)[0] ?? '').toLowerCase();
}

function applies(window: UsageWindow, route: Route, now: number): boolean {
  if (window.used === null || window.label === PER_MINUTE) return false;
  if (window.resetAt !== null && Date.parse(window.resetAt) <= now) return false;
  if (route.connection.provider === 'gemini') return window.label === route.model;
  const scope = scopeOf(window.label);
  return scope === null || route.model.toLowerCase().split(/[^a-z0-9]+/).includes(scope);
}

export function windowsFor(route: Route, now = Date.now()): UsageWindow[] {
  return (usageOf(route.connection.id)?.windows ?? []).filter((w) => applies(w, route, now));
}

const percent = (used: number): string => `${String(Math.round(used * 100))}%`;

export function holdOf(route: Route, now = Date.now()): Hold | null {
  const cool = cooling.get(keyOf(route));
  if (cool !== undefined && cool.until > now) return { reason: cool.reason, until: new Date(cool.until).toISOString() };
  const over = windowsFor(route, now).find((w) => (w.used ?? 0) > USAGE_LIMIT);
  return over === undefined ? null : { reason: `${over.label} ${percent(over.used ?? 0)}`, until: over.resetAt };
}

function fallbackModel(requested: string, conn: Connection, model: string): string {
  const bare = bareModel(requested);
  return conn.provider === 'anthropic' && isSmallModel(bare) ? bare : model;
}

function fallbackRoute(cfg: ModelConfig, fallback: Fallback, requested: string): Route | null {
  const conn = connectionOf(cfg, fallback.connection);
  if (conn === null || notReady(cfg, conn) !== null) return null;
  return { connection: conn, model: fallbackModel(requested, conn, fallback.model) };
}

const unique = (routes: Route[]): Route[] => routes.filter((route, at) => routes.findIndex((other) => keyOf(other) === keyOf(route)) === at);

export const chainOf = (primary: Route, cfg: ModelConfig, requested: string): Route[] =>
  unique([primary, ...(cfg.fallbacks ?? []).flatMap((f) => fallbackRoute(cfg, f, requested) ?? [])]);

export function routesToTry(chain: Route[], now = Date.now()): Route[] {
  const open = chain.filter((route) => holdOf(route, now) === null);
  return open.length > 0 ? open : chain.slice(0, 1);
}

function secondsHeader(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function coolUntil(headers: Headers, now: number): number {
  const after = secondsHeader(headers, 'retry-after');
  if (after !== null) return now + after * MS_PER_SECOND;
  const reset = secondsHeader(headers, 'anthropic-ratelimit-unified-reset');
  if (reset !== null && reset * MS_PER_SECOND > now) return reset * MS_PER_SECOND;
  return now + COOLDOWN_MS;
}

export function noteRefused(route: Route, status: number, headers: Headers, next: Route | undefined, now = Date.now()): void {
  const reason = `answered ${String(status)}`;
  cooling.set(keyOf(route), { until: coolUntil(headers, now), reason });
  log.warn({ from: routeLabel(route), to: next === undefined ? null : routeLabel(next), status }, 'gateway: the model hit its limit, so the request goes to the next fallback model');
}

export function noteChoice(primary: Route, chosen: Route, now = Date.now()): void {
  const key = keyOf(chosen);
  if (key === lastChoice) return;
  const first = lastChoice === '';
  lastChoice = key;
  if (key === keyOf(primary)) {
    if (!first) log.info({ model: routeLabel(chosen), connection: chosen.connection.label }, 'gateway: back on the first model of the fallback list');
    return;
  }
  const hold = holdOf(primary, now);
  log.info(
    { from: routeLabel(primary), to: routeLabel(chosen), connection: chosen.connection.label, reason: hold?.reason ?? null, until: hold?.until ?? null },
    'gateway: the first model is over its limit, so requests go to a fallback model',
  );
}

export interface ChainRow {
  connection: string;
  model: string;
  used: number | null;
  hold: Hold | null;
  active: boolean;
}

function primaryOf(cfg: ModelConfig): Route | null {
  const conn = routedConnection(cfg);
  if (conn === null) return null;
  const served = lastServed();
  const model = conn.model !== '' ? conn.model : served?.connection === conn.id ? served.model : '';
  return { connection: conn, model };
}

function rowOf(cfg: ModelConfig, route: Route, now: number): Omit<ChainRow, 'active'> {
  const reason = notReady(cfg, route.connection);
  const used = windowsFor(route, now).reduce<number | null>((most, w) => Math.max(most ?? 0, w.used ?? 0), null);
  return { connection: route.connection.id, model: route.model, used, hold: reason === null ? holdOf(route, now) : { reason, until: null } };
}

export function chainStatus(cfg: ModelConfig, now = Date.now()): ChainRow[] {
  const primary = primaryOf(cfg);
  if (primary === null) return [];
  const listed = (cfg.fallbacks ?? []).flatMap((f) => {
    const conn = connectionOf(cfg, f.connection);
    return conn === null ? [] : [{ connection: conn, model: f.model }];
  });
  const rows = unique([primary, ...listed]).map((route) => rowOf(cfg, route, now));
  const active = Math.max(0, rows.findIndex((row) => row.hold === null));
  return rows.map((row, at) => ({ ...row, active: at === active }));
}
