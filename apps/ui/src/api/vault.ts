import { call } from './client';
import { isRecord } from './accounts';
import { signVaultRequest, type Envelope, type WalletKeys } from '../vault/crypto';

export interface VaultEntry {
  id: string;
  name: string;
  stations: string[];
  syncedAt: string;
}

export interface AgentBundle {
  version: 1;
  agent: { id: string; name: string; key: string; stations: { station: string }[] };
  connectors: unknown[];
}

export interface RestoredAgent {
  id: string;
  name: string;
  stations: number;
  connectors: number;
}

const unexpected = (): Error => new Error('Metro returned an unexpected response.');
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string') : [];

function toEntry(value: unknown): VaultEntry {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string') throw unexpected();
  return {
    id: value.id,
    name: value.name,
    stations: strings(value.stations),
    syncedAt: typeof value.syncedAt === 'string' ? value.syncedAt : '',
  };
}

async function vaultCall(
  keys: WalletKeys,
  base: string,
  method: 'GET' | 'PUT' | 'DELETE',
  path: string,
  body?: string,
): Promise<unknown> {
  const route = `/api/vault${path}`;
  return call('', {
    method,
    base: `${base}${route}`,
    auth: await signVaultRequest(keys, method, route),
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body }),
  });
}

export async function listVault(keys: WalletKeys, base: string): Promise<VaultEntry[]> {
  const body = await vaultCall(keys, base, 'GET', '');
  if (!isRecord(body) || !Array.isArray(body.entries)) throw unexpected();
  return body.entries.map(toEntry);
}

export async function putVault(
  keys: WalletKeys,
  base: string,
  id: string,
  input: { name: string; stations: string[]; envelope: Envelope },
): Promise<VaultEntry> {
  return toEntry(await vaultCall(keys, base, 'PUT', `/${id}`, JSON.stringify(input)));
}

function toEnvelope(value: unknown): Envelope {
  if (!isRecord(value) || value.v !== 1 || typeof value.agentId !== 'string') throw unexpected();
  if (typeof value.nonce !== 'string' || typeof value.ciphertext !== 'string' || !isRecord(value.key)) throw unexpected();
  const key = value.key;
  const field = (name: string): string => {
    const raw = key[name];
    if (typeof raw !== 'string') throw unexpected();
    return raw;
  };
  return {
    v: 1,
    keyVersion: typeof value.keyVersion === 'number' ? value.keyVersion : 1,
    agentId: value.agentId,
    nonce: value.nonce,
    ciphertext: value.ciphertext,
    key: {
      recipient: field('recipient'),
      recipientPublicKey: field('recipientPublicKey'),
      ephemeralPublicKey: field('ephemeralPublicKey'),
      nonce: field('nonce'),
      ciphertext: field('ciphertext'),
    },
  };
}

export async function getVault(keys: WalletKeys, base: string, id: string): Promise<Envelope> {
  const body = await vaultCall(keys, base, 'GET', `/${id}`);
  if (!isRecord(body)) throw unexpected();
  return toEnvelope(body.envelope);
}

export async function fetchBundle(token: string, agentId: string): Promise<AgentBundle> {
  const body = await call(token, { method: 'GET', path: `/${agentId}/bundle` });
  if (!isRecord(body) || body.version !== 1 || !isRecord(body.agent)) throw unexpected();
  const agent = body.agent;
  if (typeof agent.id !== 'string' || typeof agent.name !== 'string' || typeof agent.key !== 'string') throw unexpected();
  const stations = Array.isArray(agent.stations)
    ? agent.stations.filter((s): s is { station: string } => isRecord(s) && typeof s.station === 'string')
    : [];
  return {
    version: 1,
    agent: { ...agent, id: agent.id, name: agent.name, key: agent.key, stations },
    connectors: Array.isArray(body.connectors) ? body.connectors : [],
  };
}

export const stationKinds = (bundle: AgentBundle): string[] => [...new Set(bundle.agent.stations.map((s) => s.station))];

export async function restoreBundle(token: string, bundle: unknown): Promise<RestoredAgent> {
  const body = await call(token, {
    method: 'POST',
    path: '/restore',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bundle),
  });
  if (!isRecord(body) || typeof body.id !== 'string' || typeof body.name !== 'string') throw unexpected();
  return {
    id: body.id,
    name: body.name,
    stations: typeof body.stations === 'number' ? body.stations : 0,
    connectors: typeof body.connectors === 'number' ? body.connectors : 0,
  };
}
