import { call } from './client.js';
import { isRecord } from './accounts.js';
import { builtInDaemon } from '../auth/daemon.js';
import { toServer, type Server } from './servers.js';

export type StepState = 'pending' | 'active' | 'done' | 'failed';

export interface BootStep {
  key: string;
  label: string;
  state: StepState;
}

export interface BootView {
  steps: BootStep[];
  failed: boolean;
  finished: boolean;
  lines: string[];
  at: string | null;
}

export interface InstanceView {
  state: string;
  publicIp: string | null;
}

export interface LaunchOverview {
  enabled: boolean;
  region: string;
  regions: string[];
  remaining: number;
}

export interface Launched {
  server: Server;
  host: string;
  node: string;
  region: string;
  zone: string | null;
}

const launchUrl = (): string => `${builtInDaemon()}/api/launch`;
const unexpected = (): Error => new Error('Metro returned an unexpected response.');

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const nullable = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

const STATES: StepState[] = ['pending', 'active', 'done', 'failed'];

function toStep(value: unknown): BootStep | null {
  if (!isRecord(value) || typeof value.key !== 'string') return null;
  const state = STATES.find((s) => s === value.state) ?? 'pending';
  return { key: value.key, label: text(value.label), state };
}

export async function fetchLaunchOverview(): Promise<LaunchOverview> {
  const body = await call({ method: 'GET', base: launchUrl() });
  if (!isRecord(body)) throw unexpected();
  const regions = Array.isArray(body.regions) ? body.regions.filter((r): r is string => typeof r === 'string') : [];
  return {
    enabled: body.enabled === true,
    region: text(body.region),
    regions,
    remaining: typeof body.remaining === 'number' ? body.remaining : 0,
  };
}

export async function launchServer(name: string, region: string): Promise<Launched> {
  const body = await call({
    method: 'POST',
    base: launchUrl(),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(region === '' ? { name } : { name, region }),
  });
  if (!isRecord(body)) throw unexpected();
  return {
    server: toServer(body.server),
    host: text(body.host),
    node: text(body.node),
    region: text(body.region),
    zone: nullable(body.zone),
  };
}

export async function fetchInstanceView(serverId: string): Promise<InstanceView> {
  const body = await call({ method: 'GET', base: launchUrl(), path: `/${serverId}` });
  if (!isRecord(body)) throw unexpected();
  return { state: text(body.state) || 'unknown', publicIp: nullable(body.publicIp) };
}

export async function fetchBootView(serverId: string): Promise<BootView> {
  const body = await call({ method: 'GET', base: launchUrl(), path: `/${serverId}/boot` });
  if (!isRecord(body)) throw unexpected();
  const steps = Array.isArray(body.steps) ? body.steps.flatMap((s) => toStep(s) ?? []) : [];
  const lines = Array.isArray(body.lines) ? body.lines.filter((l): l is string => typeof l === 'string') : [];
  return { steps, failed: body.failed === true, finished: body.finished === true, lines, at: nullable(body.at) };
}
