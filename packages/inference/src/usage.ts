import { currentAttempt } from './attempts.js';
type Key = string;

export interface UsageWindow {
  label: string;
  used: number | null;
  resetAt: string | null;
  detail: string | null;
}

interface Tally {
  requests: number;
  input: number;
  output: number;
  cached: number;
  since: string;
}

export interface ProviderUsage {
  windows: UsageWindow[];
  note: string | null;
  at: string;
  tally: Tally | null;
}

export type Reported = Omit<ProviderUsage, 'tally'>;

const latest = new Map<Key, Reported>();
const stamps = new Map<Key, Map<string, number>>();
const tallies = new Map<Key, Tally>();
const probed = new Map<Key, number>();

export const noteUsage = (key: Key, usage: Reported): void => {
  latest.set(key, usage);
  stamps.set(key, new Map(usage.windows.map((w) => [w.label, Date.parse(usage.at)])));
};

export function mergeUsage(key: Key, usage: Reported): void {
  const seen = latest.get(key);
  const marks = stamps.get(key);
  if (seen === undefined || marks === undefined) {
    noteUsage(key, usage);
    return;
  }
  const at = Date.parse(usage.at);
  const newer = new Map(usage.windows.filter((w) => (marks.get(w.label) ?? Number.NEGATIVE_INFINITY) <= at).map((w) => [w.label, w]));
  for (const label of newer.keys()) marks.set(label, at);
  const kept = seen.windows.map((w) => newer.get(w.label) ?? w);
  const added = [...newer.values()].filter((w) => !seen.windows.some((old) => old.label === w.label));
  const later = Date.parse(seen.at) <= at;
  latest.set(key, { windows: [...kept, ...added], note: later ? usage.note : seen.note, at: later ? usage.at : seen.at });
}

export function usageSeen(): Record<Key, ProviderUsage> {
  const out: Record<Key, ProviderUsage> = {};
  for (const key of new Set<Key>([...latest.keys(), ...tallies.keys()])) {
    const reported = latest.get(key);
    const tally = tallies.get(key) ?? null;
    out[key] = reported === undefined ? { windows: [], note: null, at: tally?.since ?? new Date().toISOString(), tally } : { ...reported, tally };
  }
  return out;
}

export const usageOf = (key: Key): Reported | undefined => latest.get(key);

export const forgetUsage = (): void => {
  latest.clear();
  stamps.clear();
  tallies.clear();
  probed.clear();
};

export function mayProbe(key: Key, now: number, every: number): boolean {
  if (now - (probed.get(key) ?? Number.NEGATIVE_INFINITY) < every) return false;
  probed.set(key, now);
  return true;
}

interface Counted {
  input: number;
  output: number;
  cached: number;
}

export function tallyTokens(key: Key, counted: Counted, now = new Date()): void {
  const so = tallies.get(key) ?? { requests: 0, input: 0, output: 0, cached: 0, since: now.toISOString() };
  tallies.set(key, {
    requests: so.requests + 1,
    input: so.input + counted.input,
    output: so.output + counted.output,
    cached: so.cached + counted.cached,
    since: so.since,
  });
}

const TOKEN_FIELD = /"(input_tokens|output_tokens|cache_read_input_tokens|cache_creation_input_tokens|ephemeral_5m_input_tokens|ephemeral_1h_input_tokens|cost)"\s*:\s*(\d+(?:\.\d+)?)/g;

const FIELDS: Record<string, keyof Seen> = {
  input_tokens: 'input',
  output_tokens: 'output',
  cache_read_input_tokens: 'read',
  cache_creation_input_tokens: 'creation',
  ephemeral_5m_input_tokens: 'write5m',
  ephemeral_1h_input_tokens: 'write1h',
  cost: 'cost',
};

interface Seen {
  input: number;
  output: number;
  read: number;
  creation: number;
  write5m: number;
  write1h: number;
  cost: number;
}

export class UsageScanner {
  private carry = '';
  private readonly max: Seen = { input: 0, output: 0, read: 0, creation: 0, write5m: 0, write1h: 0, cost: 0 };
  private touched = false;
  private costed = false;

  constructor(private readonly key: Key) {}

  private scan(text: string): void {
    for (const hit of text.matchAll(TOKEN_FIELD)) {
      const field = FIELDS[hit[1] ?? ''];
      const value = Number(hit[2]);
      if (field === undefined || !Number.isFinite(value)) continue;
      if (field === 'cost') this.costed = true;
      else this.touched = true;
      this.max[field] = Math.max(this.max[field], value);
    }
  }

  feed(text: string): void {
    currentAttempt()?.firstByte();
    const joined = this.carry + text;
    const cut = joined.lastIndexOf('\n');
    if (cut === -1) {
      this.carry = joined;
      return;
    }
    this.scan(joined.slice(0, cut));
    this.carry = joined.slice(cut + 1);
  }

  done(now = new Date()): void {
    if (this.carry !== '') this.scan(this.carry);
    this.carry = '';
    if (!this.touched) return;
    const { input, output, read, creation, write5m, write1h, cost } = this.max;
    const split = write5m + write1h;
    currentAttempt()?.counted({ input, output, cacheRead: read, cacheWrite5m: split > 0 ? write5m : creation, cacheWrite1h: write1h }, this.costed ? cost : null);
    tallyTokens(this.key, { input, output, cached: read + creation }, now);
    this.touched = false;
  }
}

export const clamp = (value: number): number => Math.min(1, Math.max(0, value));

function fraction(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? clamp(value) : null;
}

const MS_THRESHOLD = 1e12;

export function whenFrom(raw: string | null, now: Date, relative = false): string | null {
  if (raw === null || raw.trim() === '') return null;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    const absolute = numeric > MS_THRESHOLD ? numeric : numeric * 1000;
    const ms = relative ? now.getTime() + numeric * 1000 : absolute;
    return new Date(ms).toISOString();
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

const ANTHROPIC_WINDOWS: [string, string][] = [
  ['5h', '5-hour window'],
  ['7d', 'Weekly, all models'],
  ['7d_sonnet', 'Weekly, Sonnet'],
];

function anthropicUnified(headers: Headers, now: Date): { windows: UsageWindow[]; note: string | null } {
  const windows: UsageWindow[] = [];
  let note: string | null = null;
  for (const [key, label] of ANTHROPIC_WINDOWS) {
    const used = fraction(headers.get(`anthropic-ratelimit-unified-${key}-utilization`));
    if (used === null) continue;
    const status = headers.get(`anthropic-ratelimit-unified-${key}-status`);
    const blocked = status !== null && status !== 'allowed' ? status.replaceAll('_', ' ') : null;
    if (blocked !== null && note === null) note = `${label}: ${blocked}`;
    windows.push({ label, used, resetAt: whenFrom(headers.get(`anthropic-ratelimit-unified-${key}-reset`), now), detail: blocked });
  }
  return { windows, note };
}

export const PER_MINUTE = 'Tokens per minute';

function anthropicKeyed(headers: Headers, now: Date): UsageWindow[] {
  const limit = Number(headers.get('anthropic-ratelimit-tokens-limit'));
  const remaining = Number(headers.get('anthropic-ratelimit-tokens-remaining'));
  if (!Number.isFinite(limit) || !Number.isFinite(remaining) || limit <= 0) return [];
  return [
    {
      label: PER_MINUTE,
      used: clamp(1 - remaining / limit),
      resetAt: whenFrom(headers.get('anthropic-ratelimit-tokens-reset'), now),
      detail: `${remaining.toLocaleString('en-US')} of ${limit.toLocaleString('en-US')} left`,
    },
  ];
}

export function anthropicUsage(headers: Headers, now = new Date()): Reported | null {
  const unified = anthropicUnified(headers, now);
  if (unified.windows.length > 0) return { ...unified, at: now.toISOString() };
  const keyed = anthropicKeyed(headers, now);
  return keyed.length === 0 ? null : { windows: keyed, note: null, at: now.toISOString() };
}

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

export function windowLabel(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return 'Usage window';
  if (minutes === MINUTES_PER_WEEK) return 'Weekly';
  if (minutes % MINUTES_PER_DAY === 0) return `${String(minutes / MINUTES_PER_DAY)}-day window`;
  if (minutes % MINUTES_PER_HOUR === 0) return `${String(minutes / MINUTES_PER_HOUR)}-hour window`;
  return `${String(minutes)}-minute window`;
}

function codexWindow(headers: Headers, kind: 'primary' | 'secondary', now: Date): UsageWindow | null {
  const raw = headers.get(`x-codex-${kind}-used-percent`);
  if (raw === null) return null;
  const percent = Number(raw);
  if (!Number.isFinite(percent)) return null;
  const used = clamp(percent / 100);
  const minutes = Number(headers.get(`x-codex-${kind}-window-minutes`) ?? 'none');
  const absolute = whenFrom(headers.get(`x-codex-${kind}-reset-at`), now);
  const resetAt = absolute ?? whenFrom(headers.get(`x-codex-${kind}-reset-after-seconds`), now, true);
  return { label: windowLabel(Number.isFinite(minutes) ? minutes : null), used, resetAt, detail: null };
}

export function creditsLeft(hasCredits: boolean, raw: string | null): UsageWindow | null {
  if (!hasCredits) return null;
  const balance = Number(raw ?? 'none');
  if (!Number.isFinite(balance)) return null;
  return { label: 'Credits', used: null, resetAt: null, detail: `${balance.toLocaleString('en-US')} left` };
}

const codexCredits = (headers: Headers): UsageWindow | null =>
  creditsLeft(headers.get('x-codex-credits-has-credits') === 'true', headers.get('x-codex-credits-balance'));

export function codexUsage(headers: Headers, now = new Date()): Reported | null {
  const windows = [codexWindow(headers, 'primary', now), codexWindow(headers, 'secondary', now), codexCredits(headers)].filter(
    (w): w is UsageWindow => w !== null,
  );
  if (windows.length === 0) return null;
  const reached = headers.get('x-codex-rate-limit-reached-type');
  return { windows, note: reached === null || reached === '' ? null : reached.replaceAll('_', ' '), at: now.toISOString() };
}

export function noteUsageHeaders(kind: 'anthropic' | 'codex', key: Key, headers: Headers, now = new Date()): void {
  const usage = kind === 'anthropic' ? anthropicUsage(headers, now) : codexUsage(headers, now);
  if (usage === null) return;
  if (kind === 'anthropic') mergeUsage(key, usage);
  else noteUsage(key, usage);
}

const dollars = (value: number): string => `$${value.toFixed(2)}`;

export interface KeySpend {
  limit: number | null;
  remaining: number | null;
  spent: number;
}

function keyWindow(key: KeySpend): UsageWindow {
  if (key.limit === null || key.limit <= 0) return { label: 'Credits', used: null, resetAt: null, detail: `${dollars(key.spent)} used, no limit on this key` };
  const spent = key.remaining === null ? key.spent : Math.max(0, key.limit - key.remaining);
  return { label: 'Credits', used: clamp(spent / key.limit), resetAt: null, detail: `${dollars(spent)} of ${dollars(key.limit)} used` };
}

export const openrouterUsage = (key: KeySpend, now = new Date()): Reported => ({ windows: [keyWindow(key)], note: null, at: now.toISOString() });
