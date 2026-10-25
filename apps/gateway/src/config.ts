import { readConnectorsSetup } from '@metro-labs/connectors/setup';

export const DEFAULT_PORT = 8440;

export interface GatewayConfig {
  databaseUrl: string;
  key: Buffer;
  host: string;
  port: number;
}

function portOf(text: string | undefined): number {
  const value = (text ?? '').trim();
  if (value === '') return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('METRO_HTTP_PORT must be a port number from 1 to 65535.');
  return port;
}

export function readGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const databaseUrl = (env.DATABASE_URL ?? '').trim();
  if (databaseUrl === '') throw new Error('DATABASE_URL is not set, so gateway.metro.box cannot read model setups.');
  const setup = readConnectorsSetup(env);
  if (setup.key === null) throw new Error(`gateway.metro.box cannot start: ${setup.note}.`);
  return { databaseUrl, key: setup.key, host: (env.METRO_HTTP_HOST ?? '').trim() || '127.0.0.1', port: portOf(env.METRO_HTTP_PORT) };
}
