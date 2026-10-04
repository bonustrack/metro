import { routedDaemon, storeDaemon } from './daemon.js';
import { location, readTabItem, writeTabItem } from '../platform.js';

const LOGIN_HASH = '#/login';

const LOGIN_ROUTE = '/login';
const WAITLIST_ROUTE = '/waitlist';
const LANDING_HASH = '#/';
const STORE_KEY = 'metro.redirect';

function hashParts(): { route: string; query: URLSearchParams } {
  const raw = location().hash().replace(/^#/, '');
  const cut = raw.indexOf('?');
  const route = cut === -1 ? raw : raw.slice(0, cut);
  return {
    route,
    query: new URLSearchParams(cut === -1 ? '' : raw.slice(cut + 1)),
  };
}

export function atLogin(): boolean {
  const { route } = hashParts();
  return route === LOGIN_ROUTE || route === WAITLIST_ROUTE;
}

export const atWaitlist = (): boolean => hashParts().route === WAITLIST_ROUTE;

export interface Outcome {
  refused: string | null;
  joined: boolean;
  invited: boolean;
}

const OUTCOME_KEYS = ['refused', 'joined', 'invited'];

export function readOutcome(): Outcome {
  const { query } = hashParts();
  return { refused: query.get('refused'), joined: query.get('joined') === '1', invited: query.get('invited') === '1' };
}

export function clearOutcome(): void {
  const { route, query } = hashParts();
  if (!OUTCOME_KEYS.some((key) => query.has(key))) return;
  for (const key of OUTCOME_KEYS) query.delete(key);
  const rest = query.toString();
  replaceHash(`#${route}${rest === '' ? '' : `?${rest}`}`);
}

export function atLanding(): boolean {
  const { route } = hashParts();
  return route === '' || route === '/';
}

function safeRedirect(raw: string | null): string | null {
  if (raw === null || raw === '' || raw === '/') return null;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  if (raw === LOGIN_ROUTE || raw === WAITLIST_ROUTE) return null;
  return raw;
}

const readStored = (): string | null => safeRedirect(readTabItem(STORE_KEY));

function writeStored(target: string | null): void {
  writeTabItem(STORE_KEY, target);
}

function replaceHash(hash: string): void {
  location().replace(hash);
}

export function goToLanding(): void {
  writeStored(null);
  replaceHash(LANDING_HASH);
}

export function goToLogin(): void {
  if (atLogin()) {
    writeStored(safeRedirect(hashParts().query.get('redirect')));
    return;
  }
  if (atLanding()) return;
  const heading = routedDaemon();
  if (heading !== null) storeDaemon(heading);
  const from = safeRedirect(hashParts().route);
  writeStored(from);
  const query = from === null ? '' : `?redirect=${encodeURIComponent(from)}`;
  replaceHash(`${LOGIN_HASH}${query}`);
}

export function leaveLogin(): void {
  const here = atLogin();
  const target = (here ? safeRedirect(hashParts().query.get('redirect')) : null) ?? readStored();
  if (target === null && !here) return;
  writeStored(null);
  replaceHash(`#${target ?? '/'}`);
}
