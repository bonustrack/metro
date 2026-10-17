import { flattenAccounts, type AccountGroup } from '@metro-labs/client/api/accounts';
import { stationLabel } from '@metro-labs/client/api/attach';
import type { LatestUsage } from '@metro-labs/client/api/latest-usage';
import type { Machine } from '@metro-labs/client/api/machine';
import type { ModelSettings } from '@metro-labs/client/api/model';
import { limitingWindow, modelWindows, usageModel } from '@metro-labs/client/api/model-usage';
import { providerLabel, routedConnection, routedUsage } from '@metro-labs/client/api/providers';
import { olderThan } from '@metro-labs/client/api/version';
import type { Tone } from './tone.js';
import { modelReady } from './setup-steps.js';
import { shortVersion } from './settings-values.js';

export interface Glance {
  subtitle: string;
  value: string | null;
  tone?: Tone;
}

const WARN = 90;
const WEEK = /week/i;

const percent = (used: number): string => `${String(Math.round(used * 100))}%`;

function modelName(model: ModelSettings): string {
  const conn = routedConnection(model);
  if (conn === undefined) return 'No model yet';
  const name = conn.label === '' ? providerLabel(conn.provider) : conn.label;
  return model.source === 'organization' ? `Organization's route · ${name}` : name;
}

function usageValue(model: ModelSettings, now: number): string | null {
  const usage = routedUsage(model);
  const conn = routedConnection(model);
  if (usage === undefined || conn === undefined || model.route === null) return null;
  const windows = modelWindows(usage.windows, conn.provider, usageModel(model, model.route.primary), now);
  const week = limitingWindow(windows.filter((w) => WEEK.test(w.label)));
  if (week !== null && week.used !== null) return `${percent(week.used)} this week`;
  const most = limitingWindow(windows);
  return most === null || most.used === null ? null : `${percent(most.used)} used`;
}

export function modelGlance(model: ModelSettings, now: number, outdated: string | null = null): Glance {
  if (outdated !== null && !modelReady(model)) return { subtitle: outdated, value: 'Update Metro', tone: 'danger' };
  if (!modelReady(model)) return { subtitle: model.reason ?? modelName(model), value: 'Not ready', tone: 'danger' };
  const usage = usageValue(model, now);
  const picked = model.route === null ? '' : usageModel(model, model.route.primary);
  if (picked === '') return { subtitle: modelName(model), value: usage };
  return { subtitle: [modelName(model), usage].filter((part) => part !== null).join(' · '), value: picked };
}

export function chatsGlance(groups: AccountGroup[]): Glance {
  const accounts = flattenAccounts(groups);
  if (accounts.length === 0) return { subtitle: 'No chat yet', value: null };
  const names = [...new Set(accounts.map((a) => stationLabel(a.station)))].join(', ');
  const open = accounts.every((a) => a.row.allowlist === null);
  const on = accounts.filter((a) => a.row.enabled).length;
  return { subtitle: open ? `${names} · anyone can write` : names, value: `${String(on)} of ${String(accounts.length)} on` };
}

export function uptimeWords(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(Math.max(1, minutes))} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)} h`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day' : `${String(days)} days`;
}

function diskShare(machine: Machine | undefined): number | null {
  const disk = machine?.disk;
  if (disk === null || disk === undefined || disk.totalBytes === 0) return null;
  return ((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100;
}

function readings(machine: Machine | undefined, usage: LatestUsage | undefined): [string, number][] {
  const all: [string, number | null][] = [['CPU', usage?.cpu ?? null], ['Memory', usage?.memory ?? null], ['Disk', usage?.disk ?? diskShare(machine)]];
  return all.flatMap(([label, value]) => (value === null ? [] : [[label, value]]));
}

export function serverGlance(machine: Machine | undefined, usage: LatestUsage | undefined, place: string | null = null): Glance {
  const subtitle = place ?? (machine === undefined ? 'Online' : `Up ${uptimeWords(machine.uptimeSeconds)}`);
  const shown = readings(machine, usage);
  const worst = shown.reduce<[string, number] | null>((most, reading) => (most === null || reading[1] > most[1] ? reading : most), null);
  if (worst === null) return { subtitle, value: null };
  if (worst[1] >= WARN) return { subtitle, value: `${worst[0]} ${String(Math.round(worst[1]))}%`, tone: 'danger' };
  return { subtitle, value: 'All good', tone: 'success' };
}

export function versionGlance(version: string | null | undefined, latest: string | null | undefined): Glance | undefined {
  if (version === undefined || version === null) return undefined;
  const behind = latest !== undefined && latest !== null && olderThan(version, latest);
  return { subtitle: behind ? `Update to ${shortVersion(latest)}` : 'Up to date', value: shortVersion(version) };
}

export function uptimeGlance(machine: Machine | undefined): Glance | undefined {
  if (machine === undefined) return undefined;
  return { subtitle: 'Since the last restart', value: uptimeWords(machine.uptimeSeconds) };
}
