import type { OrgAgent, OrganizationRow } from './auth.js';
import type { RuntimeSnapshot } from './claude-box.js';
import type { ModelSettings } from './model.js';
import type { ModeInfo } from './mode.js';
import { modelOrder, type ModelOrderItem } from './model-order.js';
import { filled } from '../read.js';
import { limitingWindow, missingUsage, modelWindows, usageDetail, usageReported } from './model-usage.js';
import { windowLine, type UsageWindow } from './usage.js';

export interface DashboardReading<T> {
  data: T | null;
  at: number | null;
  error: string | null;
  unavailable: boolean;
}

export interface DashboardRow {
  key: string;
  organization: OrganizationRow;
  agent: OrgAgent;
  mode: DashboardReading<ModeInfo>;
  session: DashboardReading<RuntimeSnapshot>;
  model: DashboardReading<ModelSettings>;
}

export interface DashboardState {
  organizations: OrganizationRow[] | null;
  rows: DashboardRow[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
}

export const emptyReading = <T>(): DashboardReading<T> => ({ data: null, at: null, error: null, unavailable: false });
export const dashboardKey = (organization: string, agent: OrgAgent): string => JSON.stringify([organization, agent.id, agent.host]);

function modelConnection(item: ModelOrderItem): string {
  const label = filled(item.connection?.label) ?? item.connection?.provider ?? 'Connection';
  const account = item.connection?.account;
  return account == null ? label : `${label} · ${account}`;
}

function modelLimit(item: ModelOrderItem, now: number): UsageWindow | null {
  return item.usage === undefined ? null : limitingWindow(modelWindows(item.usage.windows, item.connection?.provider ?? 'anthropic', item.model, now));
}

function modelUsage(item: ModelOrderItem, now: number): string {
  const provider = item.connection?.provider ?? 'anthropic';
  if (item.usage === undefined) return missingUsage(provider);
  const limit = modelLimit(item, now);
  return limit === null ? usageDetail(item.usage, provider, item.model, now) : `${limit.label} · ${windowLine(limit, now)}`;
}

function routeNote(item: ModelOrderItem): string {
  const hold = item.row?.hold;
  if (hold != null) return hold.reason;
  return item.slot.kind === 'fallback' ? 'Current fallback route' : 'Primary route';
}

export function dashboardModel(settings: ModelSettings, now = Date.now()): { model: string; connection: string; usage: string; used: number | null; report: string | null; note: string | null } {
  const order = modelOrder(settings);
  const item = order.find((row) => row.row?.active) ?? order[0];
  if (item?.connection === undefined)
    return { model: 'Model unavailable', connection: 'Connection unavailable', usage: 'Usage unavailable', used: null, report: null, note: null };
  return {
    model: filled(item.model) ?? 'Model not reported',
    connection: modelConnection(item), usage: modelUsage(item, now), used: modelLimit(item, now)?.used ?? null,
    report: item.usage === undefined ? null : usageReported(item.usage, now),
    note: routeNote(item),
  };
}
