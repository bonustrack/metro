import { RESERVED_SEGMENTS, splitOrganization } from './org-segment.js';
import { apiBase, location, readItem, writeItem } from '../platform.js';

const DAEMON_KEY = 'metro.daemon';
const SERVER_KEY = 'metro.server';
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{10}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export const builtInDaemon = (): string => apiBase();

const FIRST_SEGMENT = /^#\/([A-Za-z0-9][A-Za-z0-9._-]*(?::[0-9]{1,5})?)(?:\/|$)/;

export function baseFromSegment(segment: string): string {
  const host = segment.replace(/:\d+$/, '');
  return `${LOOPBACK.has(host) ? 'http' : 'https'}://${segment}`;
}

export function routedSegment(hash?: string): string | null {
  const current = splitOrganization(hash ?? location().hash()).rest;
  const segment = FIRST_SEGMENT.exec(current)?.[1];
  return segment === undefined || RESERVED_SEGMENTS.has(segment) ? null : segment;
}

export const looksLikeHost = (segment: string): boolean => /[.:]/.test(segment);

export function routedDaemon(hash?: string): string | null {
  const segment = routedSegment(hash);
  return segment === null || !looksLikeHost(segment) ? null : baseFromSegment(segment);
}

let current: { id: string; host: string } | null = null;

export function setCurrentServer(server: { id: string; host: string } | null): void {
  current = server;
}

export const currentServer = (): { id: string; host: string } | null => current;

export function storedServerId(): string | null {
  const v = readItem(SERVER_KEY);
  return v !== null && ID_RE.test(v) ? v : null;
}

export function storeServerId(id: string | null): void {
  writeItem(SERVER_KEY, id);
}

export function daemonHost(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}

function storedDaemon(): string | null {
  const v = readItem(DAEMON_KEY);
  return v !== null && v.length > 0 ? v : null;
}

export function storeDaemon(base: string | null): void {
  writeItem(DAEMON_KEY, base);
}

export function daemonBase(): string {
  const routed = routedDaemon();
  if (routed !== null) return routed;
  if (current !== null) return baseFromSegment(current.host);
  return storedDaemon() ?? builtInDaemon();
}
