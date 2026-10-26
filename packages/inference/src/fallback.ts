import { log } from '@metro-labs/core/log';
import { lastServed } from './served.js';
import { PER_MINUTE, usageOf, type UsageWindow } from './usage.js';
import { bareModel, connectionOf, isSmallModel, notReady, primaryRoute, routeLabel, type Connection, type Fallback, type ModelSetup, type Route } from './model-config.js';

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

export type Lane = 'main' | 'helpers';

const cooling = new Map<string, Cooling>();
const lastChoice = new Map<string, string>();

const keyOf = (route: Route): string => `${route.connection.id}\n${route.model}`;

export function forgetFallbackState(): void {
  cooling.clear();
  lastChoice.clear();
}

function scopeOf(label: string): string | null {
  if (!label.startsWith(SCOPED) || label === 'Weekly, all models') return null;
  return (label.slice(SCOPED.length).trim().split(/\s+/)[0] ?? '').toLowerCase();
}

function applies(window: UsageWindow, route: Route, now: number): boolean {
  if (window.used === null || window.label === PER_MINUTE) return false;
  if (window.resetAt !== null && Date.parse(window.resetAt) <= now) return false;
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

function fallbackRoute(setup: ModelSetup, fallback: Fallback, requested: string): Route | null {
  const conn = connectionOf(setup, fallback.connection);
  if (conn === null || notReady({ connection: conn, model: fallback.model }) !== null) return null;
  return { connection: conn, model: fallbackModel(requested, conn, fallback.model) };
}

const unique = (routes: Route[]): Route[] => routes.filter((route, at) => routes.findIndex((other) => keyOf(other) === keyOf(route)) === at);

export const chainOf = (primary: Route, setup: ModelSetup, requested: string): Route[] =>
  unique([primary, ...setup.fallbacks.flatMap((f) => fallbackRoute(setup, f, requested) ?? [])]);

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
  const signedOut = status === 401;
  cooling.set(keyOf(route), { until: coolUntil(headers, now), reason: signedOut ? 'token refused, sign in again' : `answered ${String(status)}` });
  const why = signedOut ? 'gateway: Anthropic refused the Claude subscription, so the request goes to the next fallback model' : 'gateway: the model hit its limit, so the request goes to the next fallback model';
  log.warn({ from: routeLabel(route), to: next === undefined ? null : routeLabel(next), status }, why);
}

export function noteChoice(primary: Route, chosen: Route, lane: Lane, now = Date.now(), scope = ''): void {
  const key = keyOf(chosen);
  const at = `${scope}\n${lane}`;
  const last = lastChoice.get(at);
  if (key === last) return;
  lastChoice.set(at, key);
  if (key === keyOf(primary)) {
    if (last !== undefined) log.info({ lane, model: routeLabel(chosen), connection: chosen.connection.label }, 'gateway: back on the first model of the fallback list');
    return;
  }
  const hold = holdOf(primary, now);
  log.info(
    { lane, from: routeLabel(primary), to: routeLabel(chosen), connection: chosen.connection.label, reason: hold?.reason ?? null, until: hold?.until ?? null },
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

function primaryOf(setup: ModelSetup): Route | null {
  const primary = primaryRoute(setup);
  if (primary === null) return null;
  const served = lastServed();
  const model = primary.model !== '' ? primary.model : served?.connection === primary.connection.id ? served.model : '';
  return { connection: primary.connection, model };
}

type Readiness = (route: Route) => string | null;

function rowOf(route: Route, now: number, ready: Readiness): Omit<ChainRow, 'active'> {
  const reason = ready(route);
  const used = windowsFor(route, now).reduce<number | null>((most, w) => Math.max(most ?? 0, w.used ?? 0), null);
  return { connection: route.connection.id, model: route.model, used, hold: reason === null ? holdOf(route, now) : { reason, until: null } };
}

export function chainStatus(setup: ModelSetup, now = Date.now(), ready: Readiness = notReady): ChainRow[] {
  const primary = primaryOf(setup);
  if (primary === null) return [];
  const listed = setup.fallbacks.flatMap((f) => {
    const conn = connectionOf(setup, f.connection);
    return conn === null ? [] : [{ connection: conn, model: f.model }];
  });
  const rows = unique([primary, ...listed]).map((route) => rowOf(route, now, ready));
  const active = Math.max(0, rows.findIndex((row) => row.hold === null));
  return rows.map((row, at) => ({ ...row, active: at === active }));
}
