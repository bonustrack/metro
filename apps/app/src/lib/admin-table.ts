export type SortDir = 'asc' | 'desc';

export interface SortState<K extends string> {
  key: K;
  dir: SortDir;
}

export type SortValue = string | number | null;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

function compareValues(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true });
}

function compareNullable(a: SortValue, b: SortValue, sign: number): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return sign * compareValues(a, b);
}

export function sortRows<T, K extends string>(rows: readonly T[], sort: SortState<K>, value: (row: T, key: K) => SortValue, tie: (row: T) => string): T[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => compareNullable(value(a, sort.key), value(b, sort.key), sign) || compareValues(tie(a), tie(b)));
}

export function nextSort<K extends string>(current: SortState<K>, key: K, start: Record<K, SortDir>): SortState<K> {
  if (current.key !== key) return { key, dir: start[key] };
  return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
}

export function matchesQuery(query: string, fields: readonly (string | null | undefined)[]): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return true;
  const text = fields.filter((field): field is string => typeof field === 'string').join(' ').toLowerCase();
  return words.every((word) => text.includes(word));
}

const counted = (count: number, word: string): string => `${String(count)} ${word}${count === 1 ? '' : 's'} ago`;

export function agoWords(at: number | null, now: number): string {
  if (at === null) return 'Never';
  const ago = now - at;
  if (ago < MINUTE) return 'Just now';
  if (ago < HOUR) return `${String(Math.floor(ago / MINUTE))} min ago`;
  if (ago < DAY) return counted(Math.floor(ago / HOUR), 'hour');
  if (ago < 2 * DAY) return 'Yesterday';
  if (ago < WEEK) return counted(Math.floor(ago / DAY), 'day');
  if (ago < MONTH) return counted(Math.floor(ago / WEEK), 'week');
  if (ago < YEAR) return counted(Math.floor(ago / MONTH), 'month');
  return counted(Math.floor(ago / YEAR), 'year');
}

export function timeOf(iso: string | null): number | null {
  if (iso === null) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : at;
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-[a-z]+\.(\d+))?$/i;

export function versionRank(version: string | null): number | null {
  const m = version === null ? null : VERSION_RE.exec(version);
  if (m === null) return null;
  const release = (Number(m[1]) * 1_000 + Number(m[2])) * 1_000 + Number(m[3]);
  return release * 100_000 + (m[4] === undefined ? 99_999 : Number(m[4]));
}
