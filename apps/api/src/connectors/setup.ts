import { log } from '@metro-labs/core/log';
import { connectorsKeyOf } from './secrets.js';

export interface ConnectorsSetup {
  enabled: boolean;
  key: Buffer | null;
  note: string;
}

const read = (env: NodeJS.ProcessEnv, name: string): string => (env[name] ?? '').trim();

export function readConnectorsSetup(env: NodeJS.ProcessEnv = process.env): ConnectorsSetup {
  if (read(env, 'METRO_CONNECTORS_ENABLED') !== 'true') return { enabled: false, key: null, note: 'organization connectors are off (METRO_CONNECTORS_ENABLED is not true)' };
  const text = read(env, 'METRO_CONNECTORS_KEY');
  if (text === '') return { enabled: true, key: null, note: 'METRO_CONNECTORS_KEY is unset, so no connector secret can be kept' };
  const key = connectorsKeyOf(text);
  if (key === null) return { enabled: true, key: null, note: 'METRO_CONNECTORS_KEY must be 32 bytes in base64 (openssl rand -base64 32), so no connector secret can be kept' };
  return { enabled: true, key, note: 'connector secrets are sealed with METRO_CONNECTORS_KEY' };
}

export function announceConnectorsSetup(setup: ConnectorsSetup): void {
  const fields = { enabled: setup.enabled, sealing: setup.key !== null };
  if (setup.enabled && setup.key === null) log.warn(fields, `connectors: ${setup.note}`);
  else log.info(fields, `connectors: ${setup.note}`);
}
