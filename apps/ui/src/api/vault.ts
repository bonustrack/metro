import { daemonBase } from '../auth/daemon.js';
import { call } from './client.js';
import { filled, isRecord } from './read.js';

export interface VaultSecret {
  id: string;
  name: string;
  env: string;
  hosts: string[];
  updatedAt: string;
}

interface VaultRequest {
  at: string;
  method: string;
  host: string;
  path: string;
  status: number | null;
  swapped: string[];
}

export interface Vault {
  available: boolean;
  enabled: boolean;
  running: boolean;
  problem: string | null;
  browsers: string | null;
  secrets: VaultSecret[];
  recent: VaultRequest[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

const secretOf = (raw: unknown): VaultSecret[] =>
  isRecord(raw) && typeof raw.id === 'string' ? [{ id: raw.id, name: str(raw.name), env: str(raw.env), hosts: strings(raw.hosts), updatedAt: str(raw.updatedAt) }] : [];

const requestOf = (raw: unknown): VaultRequest[] =>
  isRecord(raw)
    ? [{ at: str(raw.at), method: str(raw.method), host: str(raw.host), path: str(raw.path), status: typeof raw.status === 'number' ? raw.status : null, swapped: strings(raw.swapped) }]
    : [];

function toVault(body: unknown): Vault {
  if (!isRecord(body)) throw new Error('Metro returned an unexpected response.');
  return {
    available: body.available === true,
    enabled: body.enabled === true,
    running: body.running === true,
    problem: filled(body.problem),
    browsers: filled(body.browsers),
    secrets: Array.isArray(body.secrets) ? body.secrets.flatMap(secretOf) : [],
    recent: Array.isArray(body.recent) ? body.recent.flatMap(requestOf) : [],
  };
}

const BASE = (): string => `${daemonBase()}/api/vault`;

export const fetchVault = async (): Promise<Vault> => toVault(await call({ method: 'GET', base: BASE() }));

export async function changeVault(body: Record<string, unknown>): Promise<Vault> {
  return toVault(await call({ method: 'POST', base: BASE(), headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
}

export const envNameOf = (name: string): string =>
  name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'KEY_$1');

export const hostsOf = (text: string): string[] => text.split(/[\s,]+/).map((h) => h.trim()).filter((h) => h !== '');
