import type { RunEntry } from './model.js';

export interface RunFilters {
  q: string;
  sender: string;
  station: string;
  account: string;
  channel: string;
  status: string;
  kind: string;
  time: string;
  worker: string;
  direction: string;
}

export const DEFAULT_FILTERS: RunFilters = {
  q: '', sender: 'All', station: 'All', account: 'All', channel: 'All',
  status: 'All', kind: 'All', time: 'All', worker: 'All', direction: 'All',
};

export type Dimension = Exclude<keyof RunFilters, 'q'>;
interface FilterOption { value: string; label: string }
export const DIMENSIONS: Dimension[] = ['sender', 'station', 'account', 'channel', 'worker', 'status', 'direction', 'time'];
export const LABELS: Record<Dimension, string> = {
  sender: 'senders', station: 'stations', account: 'accounts', channel: 'channels',
  status: 'states', kind: 'events', time: 'retained time', worker: 'workers', direction: 'directions',
};

function valueOf(entry: RunEntry, key: Dimension): string {
  if (key === 'sender') return entry.senderId;
  if (key === 'channel') return entry.line;
  if (key === 'time') return 'All';
  return entry[key];
}

function labelOf(entry: RunEntry, key: Dimension): string {
  if (key === 'sender') return entry.sender;
  if (key === 'channel') return entry.channel || 'No channel';
  if (key === 'account') return entry.account || 'No account';
  return valueOf(entry, key);
}

export function filterOptions(entries: RunEntry[], key: Dimension): FilterOption[] {
  if (key === 'time') return [
    { value: 'All', label: 'All retained time' }, { value: '5', label: 'Last 5 minutes' },
    { value: '15', label: 'Last 15 minutes' }, { value: '60', label: 'Last hour' },
  ];
  const options = new Map<string, string>();
  for (const entry of entries) options.set(valueOf(entry, key), labelOf(entry, key));
  const counts = new Map<string, number>();
  for (const label of options.values()) counts.set(label, (counts.get(label) ?? 0) + 1);
  const named = [...options].map(([value, label]) => ({ value, label: (counts.get(label) ?? 0) > 1 ? `${label} · ${value}` : label }));
  return [{ value: 'All', label: `All ${LABELS[key]}` }, ...named.sort((a, b) => a.label.localeCompare(b.label))];
}

export function filterEntries(entries: RunEntry[], filters: RunFilters, now: number): RunEntry[] {
  const query = filters.q.trim().toLocaleLowerCase();
  return entries.filter((entry) => {
    if (filters.time !== 'All' && entry.at < now - Number(filters.time) * 60_000) return false;
    for (const key of [...DIMENSIONS, 'kind'] as const) {
      if (key !== 'time' && filters[key] !== 'All' && valueOf(entry, key) !== filters[key]) return false;
    }
    return query === '' || [entry.sender, entry.senderId, entry.title, entry.text, entry.station, entry.account, entry.channel,
      entry.line, entry.worker, entry.status, entry.direction, entry.id, entry.messageId, entry.replyTo, entry.toolUseId]
      .join(' ').toLocaleLowerCase().includes(query);
  });
}

export function filterCount(filters: RunFilters): number {
  return (filters.q.trim() === '' ? 0 : 1) + [...DIMENSIONS, 'kind' as const].filter((key) => filters[key] !== 'All').length;
}

export interface EventBucket { start: number; end: number; count: number }

export function eventBuckets(entries: RunEntry[]): EventBucket[] {
  if (entries.length === 0) return [];
  const first = Math.min(...entries.map((entry) => entry.at));
  const last = Math.max(...entries.map((entry) => entry.at));
  const step = Math.max(60_000, Math.ceil((last - first + 1) / 24 / 60_000) * 60_000);
  const start = Math.floor(first / step) * step;
  const size = Math.floor((last - start) / step) + 1;
  const buckets = Array.from({ length: size }, (_, index) => ({ start: start + index * step, end: start + (index + 1) * step, count: 0 }));
  for (const entry of entries) {
    const bucket = buckets[Math.floor((entry.at - start) / step)];
    if (bucket !== undefined) bucket.count += 1;
  }
  return buckets;
}
