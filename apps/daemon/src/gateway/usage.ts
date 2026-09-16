export type UsageProvider = 'anthropic' | 'codex' | 'openrouter';

export interface UsageWindow {
  label: string;
  used: number | null;
  resetAt: string | null;
  detail: string | null;
}

export interface ProviderUsage {
  windows: UsageWindow[];
  note: string | null;
  at: string;
}

const latest = new Map<UsageProvider, ProviderUsage>();

export const noteUsage = (provider: UsageProvider, usage: ProviderUsage): void => {
  latest.set(provider, usage);
};

export const usageSeen = (): Partial<Record<UsageProvider, ProviderUsage>> => Object.fromEntries(latest);

export const usageOf = (provider: UsageProvider): ProviderUsage | undefined => latest.get(provider);

export const forgetUsage = (): void => {
  latest.clear();
};

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

export function anthropicUsage(headers: Headers, now = new Date()): ProviderUsage | null {
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

export function codexUsage(headers: Headers, now = new Date()): ProviderUsage | null {
  const windows = [codexWindow(headers, 'primary', now), codexWindow(headers, 'secondary', now)].filter(
    (w): w is UsageWindow => w !== null,
  );
  if (windows.length === 0) return null;
  const reached = headers.get('x-codex-rate-limit-reached-type');
  return { windows, note: reached === null || reached === '' ? null : reached.replaceAll('_', ' '), at: now.toISOString() };
}

export function noteUsageHeaders(provider: 'anthropic' | 'codex', headers: Headers, now = new Date()): void {
  const usage = provider === 'anthropic' ? anthropicUsage(headers, now) : codexUsage(headers, now);
  if (usage !== null) noteUsage(provider, usage);
}

const dollars = (value: number): string => `$${value.toFixed(2)}`;

export function openrouterUsage(total: number, spent: number, now = new Date()): ProviderUsage {
  const used = total > 0 ? clamp(spent / total) : null;
  return {
    windows: [{ label: 'Credits', used, resetAt: null, detail: `${dollars(spent)} of ${dollars(total)} used` }],
    note: null,
    at: now.toISOString(),
  };
}
