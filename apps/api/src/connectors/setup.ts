import { log } from '@metro-labs/core/log';
import { connectorsKeyOf } from './secrets.js';

export interface ConnectorsSetup {
  key: Buffer | null;
  note: string;
}

export function readConnectorsSetup(env: NodeJS.ProcessEnv = process.env): ConnectorsSetup {
  const text = (env.METRO_CONNECTORS_KEY ?? '').trim();
  if (text === '') return { key: null, note: 'METRO_CONNECTORS_KEY is unset, so no connector secret can be kept or delivered' };
  const key = connectorsKeyOf(text);
  if (key === null) return { key: null, note: 'METRO_CONNECTORS_KEY must be 32 bytes in base64 (openssl rand -base64 32), so no connector secret can be kept or delivered' };
  return { key, note: 'connector secrets are sealed with METRO_CONNECTORS_KEY' };
}

export function announceConnectorsSetup(setup: ConnectorsSetup): void {
  const fields = { sealing: setup.key !== null };
  if (setup.key === null) log.warn(fields, `connectors: ${setup.note}`);
  else log.info(fields, `connectors: ${setup.note}`);
}
