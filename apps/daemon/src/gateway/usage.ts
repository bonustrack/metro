import { isRecord } from '@metro-labs/core/is-record';
import { stringOf } from '@metro-labs/http/api-http';

type Key = string;

interface UsageWindow {
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
const tallies = new Map<Key, Tally>();
const probed = new Map<Key, number>();
const answers = new Map<Key, Reported>();

export const noteUsage = (key: Key, usage: Reported): void => {
  latest.set(key, usage);
};

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

export const forgetOne = (key: Key): void => {
  latest.delete(key);
  tallies.delete(key);
  probed.delete(key);
};

export const forgetUsage = (): void => {
  latest.clear();
  tallies.clear();
  probed.clear();
  answers.clear();
};

export function mayProbe(key: Key, now: number, every: number): boolean {
  if (now - (probed.get(key) ?? Number.NEGATIVE_INFINITY) < every) return false;
  probed.set(key, now);
  return true;
}

export const probeAnswer = (key: Key): Reported | undefined => answers.get(key);

export const keepProbeAnswer = (key: Key, usage: Reported): void => {
  answers.set(key, usage);
};

export interface Counted {
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

const TOKEN_FIELD = /"(input_tokens|output_tokens|cache_read_input_tokens|cache_creation_input_tokens)"\s*:\s*(\d+)/g;

export class UsageScanner {
  private carry = '';
  private readonly max = { input: 0, output: 0, read: 0, creation: 0 };
  private touched = false;

  constructor(private readonly key: Key) {}

  private scan(text: string): void {
    for (const hit of text.matchAll(TOKEN_FIELD)) {
      const value = Number(hit[2]);
      if (!Number.isFinite(value)) continue;
      this.touched = true;
      if (hit[1] === 'input_tokens') this.max.input = Math.max(this.max.input, value);
      else if (hit[1] === 'output_tokens') this.max.output = Math.max(this.max.output, value);
      else if (hit[1] === 'cache_read_input_tokens') this.max.read = Math.max(this.max.read, value);
      else this.max.creation = Math.max(this.max.creation, value);
    }
  }

  feed(text: string): void {
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
    tallyTokens(this.key, { input: this.max.input, output: this.max.output, cached: this.max.read + this.max.creation }, now);
    this.touched = false;
  }
}

const clamp = (value: number): number => Math.min(1, Math.max(0, value));

function fraction(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? clamp(value) : null;
}

const MS_THRESHOLD = 1e12;

function whenFrom(raw: string | null, now: Date, relative = false): string | null {
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
  ['7d', 'Weekly'],
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

function anthropicKeyed(headers: Headers, now: Date): UsageWindow[] {
  const limit = Number(headers.get('anthropic-ratelimit-tokens-limit'));
  const remaining = Number(headers.get('anthropic-ratelimit-tokens-remaining'));
  if (!Number.isFinite(limit) || !Number.isFinite(remaining) || limit <= 0) return [];
  return [
    {
      label: 'Tokens per minute',
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

function creditsLeft(hasCredits: boolean, raw: string | null): UsageWindow | null {
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

const present = (w: UsageWindow | null): w is UsageWindow => w !== null;

const textOf = (raw: unknown): string | null => (typeof raw === 'number' || typeof raw === 'string' ? String(raw) : null);

const numberOf = (raw: unknown): number | null => (typeof raw === 'number' && Number.isFinite(raw) ? raw : null);

const SECONDS_PER_MINUTE = 60;

function codexBodyWindow(raw: unknown, now: Date): UsageWindow | null {
  if (!isRecord(raw)) return null;
  const percent = numberOf(raw.used_percent);
  if (percent === null) return null;
  const seconds = numberOf(raw.limit_window_seconds);
  const minutes = seconds === null || seconds <= 0 ? null : Math.ceil(seconds / SECONDS_PER_MINUTE);
  const resetAt = whenFrom(textOf(raw.reset_at), now) ?? whenFrom(textOf(raw.reset_after_seconds), now, true);
  return { label: windowLabel(minutes), used: clamp(percent / 100), resetAt, detail: null };
}

function codexWall(limit: Record<string, unknown>, reached: unknown): string | null {
  if (limit.limit_reached !== true && limit.allowed !== false) return null;
  const kind = isRecord(reached) ? stringOf(reached.type) : '';
  return kind === '' ? 'limit reached' : kind.replaceAll('_', ' ');
}

export function codexUsageBody(body: unknown, now = new Date()): Reported | null {
  if (!isRecord(body)) return null;
  const limit = isRecord(body.rate_limit) ? body.rate_limit : {};
  const credits = isRecord(body.credits) ? body.credits : {};
  const windows = [
    codexBodyWindow(limit.primary_window, now),
    codexBodyWindow(limit.secondary_window, now),
    creditsLeft(credits.has_credits === true, textOf(credits.balance)),
  ].filter(present);
  return windows.length === 0 ? null : { windows, note: codexWall(limit, body.rate_limit_reached_type), at: now.toISOString() };
}

const CLAUDE_WINDOWS: [string, string][] = [
  ['five_hour', '5-hour window'],
  ['seven_day', 'Weekly'],
  ['seven_day_sonnet', 'Weekly, Sonnet'],
  ['seven_day_opus', 'Weekly, Opus'],
];

function percentWindow(label: string, raw: unknown, now: Date): UsageWindow | null {
  if (!isRecord(raw)) return null;
  const percent = numberOf(raw.utilization) ?? numberOf(raw.percent);
  if (percent === null) return null;
  return { label, used: clamp(percent / 100), resetAt: whenFrom(textOf(raw.resets_at), now), detail: null };
}

function scopedName(entry: Record<string, unknown>): string {
  if (stringOf(entry.display_name) !== '') return stringOf(entry.display_name);
  if (entry.kind !== 'weekly_scoped' || !isRecord(entry.scope) || !isRecord(entry.scope.model)) return '';
  return stringOf(entry.scope.model.display_name);
}

function scopedWindows(limits: Record<string, unknown>, now: Date): (UsageWindow | null)[] {
  const listed = [limits.model_scoped, limits.limits].flatMap((list): unknown[] => (Array.isArray(list) ? (list as unknown[]) : []));
  return listed.map((entry) => {
    const name = isRecord(entry) ? scopedName(entry) : '';
    return name === '' ? null : percentWindow(`Weekly, ${name}`, entry, now);
  });
}

export function claudeLoginUsage(limits: unknown, now = new Date()): Reported | null {
  if (!isRecord(limits)) return null;
  const all = [...CLAUDE_WINDOWS.map(([key, label]) => percentWindow(label, limits[key], now)), ...scopedWindows(limits, now)].filter(present);
  const windows = all.filter((w, index) => all.findIndex((other) => other.label === w.label) === index);
  return windows.length === 0 ? null : { windows, note: null, at: now.toISOString() };
}

export function noteUsageHeaders(kind: 'anthropic' | 'codex', key: Key, headers: Headers, now = new Date()): void {
  const usage = kind === 'anthropic' ? anthropicUsage(headers, now) : codexUsage(headers, now);
  if (usage !== null) noteUsage(key, usage);
}

const dollars = (value: number): string => `$${value.toFixed(2)}`;

export interface QuotaRow {
  id: string;
  remaining: number | null;
  resetAt: string | null;
}

export function geminiUsage(rows: QuotaRow[], now = new Date()): Reported | null {
  const windows: UsageWindow[] = rows
    .filter((row) => row.remaining !== null)
    .map((row) => ({ label: row.id, used: clamp(1 - (row.remaining ?? 0)), resetAt: row.resetAt, detail: null }));
  return windows.length === 0 ? null : { windows, note: null, at: now.toISOString() };
}

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
