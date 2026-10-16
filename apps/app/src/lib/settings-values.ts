import type { ModelSettings, Provider } from '@metro-labs/client/api/model';
import { limitingWindow, modelWindows } from '@metro-labs/client/api/model-usage';
import type { ModelRoute } from '@metro-labs/client/api/model-route';
import type { PermissionMode } from '@metro-labs/client/api/claude-box';
import type { ServerSize } from '@metro-labs/client/api/size';
import type { UsageWindow } from '@metro-labs/client/api/usage';
import { regionName } from '@metro-labs/client/aws/regions';
import type { Tone } from './tone.js';

const DISK_FULL = 90;
const PRERELEASE = /^\d+\.\d+\.\d+-/;
const IN_PARENS = /\(([^)]+)\)/;

export interface Shown {
  text: string;
  tone: Tone;
}

export const shortVersion = (version: string | null): string => (version === null ? 'Unknown' : version.replace(PRERELEASE, ''));

export function regionShort(code: string): string {
  const name = regionName(code);
  return IN_PARENS.exec(name)?.[1] ?? name;
}

const gigabytes = (mib: number): string => `${String(Math.round((mib / 1024) * 10) / 10)} GB`;

export function sizeValue(size: ServerSize): string {
  const cpu = size.vcpus === null ? '' : `${String(size.vcpus)} ${size.vcpus === 1 ? 'CPU' : 'CPUs'}`;
  const memory = size.memoryMib === null ? '' : gigabytes(size.memoryMib);
  const parts = [cpu, memory].filter((part) => part !== '');
  return parts.length === 0 ? size.type : parts.join(' · ');
}

export const storageValue = (sizeGib: number, diskUsed: number | null): string =>
  diskUsed === null ? `${String(sizeGib)} GB` : `${String(sizeGib)} GB · ${String(Math.round(diskUsed))}% used`;

interface HealthInput {
  state: string | undefined;
  running: boolean | undefined;
  disk: number | null;
}

export function healthValue({ state, running, disk }: HealthInput): Shown {
  if (state === undefined) return { text: 'Checking…', tone: 'secondary' };
  if (state === 'stopped') return { text: 'Stopped', tone: 'danger' };
  if (state === 'updating') return { text: 'Updating', tone: 'secondary' };
  if (state !== 'live') return { text: 'Offline', tone: 'danger' };
  if (running === false) return { text: 'Agent not running', tone: 'danger' };
  if (disk !== null && disk >= DISK_FULL) return { text: 'Disk almost full', tone: 'danger' };
  return { text: 'All good', tone: 'success' };
}

const percent = (used: number): string => `${String(Math.round(used * 100))}%`;

export function shownWindow(windows: UsageWindow[]): UsageWindow | null {
  const weekly = limitingWindow(windows.filter((w) => w.label.startsWith('Weekly')));
  return weekly?.used != null ? weekly : limitingWindow(windows);
}

export function usageValue(windows: UsageWindow[]): string | null {
  const shown = shownWindow(windows);
  if (shown?.used == null) return null;
  return `${percent(shown.used)} ${shown.label.startsWith('Weekly') ? 'this week' : 'used'}`;
}

export function weekUsage(usage: ModelSettings['usage'][string] | undefined, provider: Provider, model: string, now = Date.now()): string | null {
  if (usage === undefined) return null;
  const credit = usage.windows.find((w) => w.label === 'Credits')?.detail;
  if (credit != null) return credit;
  return usageValue(modelWindows(usage.windows, provider, model, now));
}

export function routeSummary(route: ModelRoute | null, nameOf: (connection: string, model: string) => string): string {
  if (route === null) return 'Not set yet';
  const first = nameOf(route.primary.connection, route.primary.model);
  const count = route.fallbacks.length;
  if (count === 0) return first;
  return `${first}, then ${String(count)} ${count === 1 ? 'backup' : 'backups'}`;
}

export const modeName = (mode: PermissionMode): string => (mode === 'bypass' ? 'bypassPermissions' : 'auto');

export const runnerValue = (legacyRunner: boolean, mode: PermissionMode | undefined): string =>
  [legacyRunner ? 'Claude Code' : 'Agent SDK', mode === undefined ? '' : modeName(mode)].filter((part) => part !== '').join(' · ');

export const promptKind = (prompt: string): string => (prompt.trim() === '' ? 'default prompt' : 'own prompt');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n: number): string => String(n).padStart(2, '0');

export function exactTime(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const d = new Date(at);
  const clock = [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map(two).join(':');
  return `${String(d.getUTCDate())} ${MONTHS[d.getUTCMonth()] ?? ''} ${String(d.getUTCFullYear())}, ${clock} UTC`;
}
