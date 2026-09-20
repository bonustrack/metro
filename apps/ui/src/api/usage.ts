import { isRecord } from './accounts.js';

export const USAGE_PROVIDERS = ['anthropic', 'codex', 'gemini', 'openrouter', 'bedrock'] as const;
export type UsageProvider = (typeof USAGE_PROVIDERS)[number];

export interface UsageWindow {
  label: string;
  used: number | null;
  resetAt: string | null;
  detail: string | null;
}

export interface Tally {
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

export type Usage = Partial<Record<UsageProvider, ProviderUsage>>;

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

function toWindow(raw: unknown): UsageWindow | null {
  if (!isRecord(raw) || typeof raw.label !== 'string') return null;
  const used = typeof raw.used === 'number' && Number.isFinite(raw.used) ? Math.min(1, Math.max(0, raw.used)) : null;
  return { label: raw.label, used, resetAt: text(raw.resetAt), detail: text(raw.detail) };
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);

function toTally(raw: unknown): Tally | null {
  if (!isRecord(raw) || typeof raw.since !== 'string') return null;
  const tally = { requests: count(raw.requests), input: count(raw.input), output: count(raw.output), cached: count(raw.cached), since: raw.since };
  return tally.requests === 0 ? null : tally;
}

function toProviderUsage(raw: unknown): ProviderUsage | null {
  if (!isRecord(raw) || typeof raw.at !== 'string' || !Array.isArray(raw.windows)) return null;
  const windows = raw.windows.flatMap((w: unknown) => toWindow(w) ?? []);
  const tally = toTally(raw.tally);
  return windows.length === 0 && tally === null ? null : { windows, note: text(raw.note), at: raw.at, tally };
}

export function toUsage(raw: unknown): Usage {
  if (!isRecord(raw)) return {};
  const out: Usage = {};
  for (const provider of USAGE_PROVIDERS) {
    const usage = toProviderUsage(raw[provider]);
    if (usage !== null) out[provider] = usage;
  }
  return out;
}

export function percentLabel(used: number): string {
  const percent = used * 100;
  const shown = percent > 0 && percent < 1 ? percent.toFixed(1) : String(Math.round(percent));
  return `${shown}% used`;
}

const THOUSAND = 1000;
const MILLION = 1_000_000;

export function tokensLabel(count: number): string {
  if (count >= MILLION) return `${(count / MILLION).toFixed(count >= 10 * MILLION ? 0 : 1)}M`;
  if (count >= THOUSAND) return `${(count / THOUSAND).toFixed(count >= 10 * THOUSAND ? 0 : 1)}k`;
  return String(count);
}

export function tallyLine(tally: Tally): string {
  const parts = [
    `${String(tally.requests)} ${tally.requests === 1 ? 'request' : 'requests'}`,
    `${tokensLabel(tally.input)} in`,
    `${tokensLabel(tally.output)} out`,
  ];
  if (tally.cached > 0) parts.push(`${tokensLabel(tally.cached)} cached`);
  return parts.join(' · ');
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function untilLabel(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const left = at - now;
  if (left <= 0) return 'resets now';
  if (left < HOUR) return `resets in ${String(Math.ceil(left / MINUTE))} min`;
  if (left < DAY) {
    const hours = Math.floor(left / HOUR);
    const minutes = Math.round((left % HOUR) / MINUTE);
    return minutes === 0 ? `resets in ${String(hours)} h` : `resets in ${String(hours)} h ${String(minutes)} min`;
  }
  const when = new Date(at);
  return `resets ${when.toLocaleDateString(undefined, { weekday: 'short' })} ${when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

export function windowLine(window: UsageWindow, now = Date.now()): string {
  const parts = [
    window.used === null ? null : percentLabel(window.used),
    window.detail,
    window.resetAt === null ? null : untilLabel(window.resetAt, now),
  ];
  return parts.filter((p): p is string => p !== null && p !== '').join(' · ');
}
