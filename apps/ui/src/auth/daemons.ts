import { daemonHost, segmentOf } from './daemon';

const LIST_KEY = 'metro.daemons';
const NAME_MAX = 40;

export interface KnownDaemon {
  base: string;
  name: string | null;
}

function read(): KnownDaemon[] {
  try {
    const raw = window.localStorage.getItem(LIST_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((d): d is { base: string; name?: unknown } => typeof d === 'object' && d !== null && typeof (d as { base?: unknown }).base === 'string')
      .map((d) => ({ base: d.base, name: typeof d.name === 'string' && d.name !== '' ? d.name : null }));
  } catch {
    return [];
  }
}

function write(list: KnownDaemon[]): void {
  try {
    window.localStorage.setItem(LIST_KEY, JSON.stringify(list));
  } catch {
    return;
  }
}

export const knownDaemons = (): KnownDaemon[] => read();

export function rememberDaemon(base: string): void {
  const list = read();
  if (list.some((d) => d.base === base)) return;
  write([...list, { base, name: null }]);
}

export function cleanDaemonName(raw: string): string | null {
  const name = raw.replace(/[\p{Cc}]/gu, '').trim().slice(0, NAME_MAX);
  return name === '' ? null : name;
}

export function nameDaemon(base: string, raw: string): void {
  const name = cleanDaemonName(raw);
  const list = read();
  const held = list.find((d) => d.base === base);
  write(held === undefined ? [...list, { base, name }] : list.map((d) => (d.base === base ? { ...d, name } : d)));
}

export function forgetDaemon(base: string): void {
  write(read().filter((d) => d.base !== base));
}

export function daemonName(base: string): string | null {
  return read().find((d) => d.base === base)?.name ?? null;
}

export function daemonLabel(base: string): string {
  return daemonName(base) ?? daemonHost(base);
}

export function goToDaemon(base: string): void {
  window.location.hash = `#/${segmentOf(base)}`;
  window.location.reload();
}
