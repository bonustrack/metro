import { readConnectorsSetup } from '@metro-labs/connectors/setup';

export const DEFAULT_PORT = 8430;
export const DEFAULT_PUBLIC_HOST = 'mcp.metro.box';

export interface McpConfig {
  databaseUrl: string;
  key: Buffer;
  host: string;
  port: number;
  publicHost: string;
}

function portOf(text: string | undefined): number {
  const value = (text ?? '').trim();
  if (value === '') return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('METRO_HTTP_PORT must be a port number from 1 to 65535.');
  return port;
}

export function readMcpConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const databaseUrl = (env.DATABASE_URL ?? '').trim();
  if (databaseUrl === '') throw new Error('DATABASE_URL is not set, so mcp.metro.box cannot read connectors.');
  const setup = readConnectorsSetup(env);
  if (setup.key === null) throw new Error(`mcp.metro.box cannot start: ${setup.note}.`);
  const publicHost = (env.METRO_MCP_HOST ?? '').trim().toLowerCase();
  return {
    databaseUrl,
    key: setup.key,
    host: (env.METRO_HTTP_HOST ?? '').trim() || '127.0.0.1',
    port: portOf(env.METRO_HTTP_PORT),
    publicHost: publicHost === '' ? DEFAULT_PUBLIC_HOST : publicHost,
  };
}
