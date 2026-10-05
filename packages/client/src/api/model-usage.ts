import type { ConnectionRow, ModelSettings, Provider } from './model.js';
import { untilLabel, type UsageWindow } from './usage.js';

const SCOPED = 'Weekly, ';
export const USAGE_LIMIT = 0.95;

export function usageLabel(label: string, provider: Provider): string {
  return provider === 'anthropic' && label === 'Weekly' ? 'Weekly, all models' : label;
}

export function modelWindows(windows: UsageWindow[], provider: Provider, model: string, now = Date.now()): UsageWindow[] {
  return windows.filter((w) => {
    if (w.used === null || w.label === 'Tokens per minute') return false;
    if (w.resetAt !== null && Date.parse(w.resetAt) <= now) return false;
    if (provider === 'gemini') return w.label === model;
    if (!w.label.startsWith(SCOPED) || w.label === 'Weekly, all models') return true;
    const scope = (w.label.slice(SCOPED.length).trim().split(/\s+/)[0] ?? '').toLowerCase();
    return model.toLowerCase().split(/[^a-z0-9]+/).includes(scope);
  }).map((w) => ({ ...w, label: usageLabel(w.label, provider) }));
}

export function limitingWindow(windows: UsageWindow[]): UsageWindow | null {
  return windows.reduce<UsageWindow | null>((most, w) => w.used !== null && (most === null || w.used > (most.used ?? 0)) ? w : most, null);
}

export function usageModel(settings: ModelSettings, conn: ConnectionRow | undefined): string {
  if (conn !== undefined && conn.model !== '') return conn.model;
  const row = settings.chain.find((r) => r.connection === (conn?.id ?? 'passthrough'));
  if (row !== undefined && row.model !== '') return row.model;
  return settings.lastServed?.connection === (conn?.id ?? 'passthrough') ? settings.lastServed.model : '';
}

export function connectionWindow(settings: ModelSettings, conn: ConnectionRow | undefined): UsageWindow | null {
  return limitingWindow(modelWindows(settings.usage[conn?.id ?? 'passthrough']?.windows ?? [], conn?.provider ?? 'anthropic', usageModel(settings, conn)));
}

export function limitNote(window: UsageWindow): string {
  return [window.label, window.resetAt === null ? '' : untilLabel(window.resetAt)].filter((part) => part !== '').join(' · ');
}
