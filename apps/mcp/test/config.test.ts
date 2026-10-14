import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { DEFAULT_PORT, DEFAULT_PUBLIC_HOST, readMcpConfig } from '../src/config.ts';

const KEY = randomBytes(32).toString('base64');

describe('mcp.metro.box configuration', () => {
  test('refuses to start without the database or the connectors key', () => {
    expect(() => readMcpConfig({ METRO_CONNECTORS_KEY: KEY })).toThrow('DATABASE_URL');
    expect(() => readMcpConfig({ DATABASE_URL: 'postgres://db' })).toThrow('METRO_CONNECTORS_KEY');
    expect(() => readMcpConfig({ DATABASE_URL: 'postgres://db', METRO_CONNECTORS_KEY: 'short' })).toThrow('32 bytes');
    expect(() => readMcpConfig({ DATABASE_URL: 'postgres://db', METRO_CONNECTORS_KEY: KEY, METRO_HTTP_PORT: 'eighty' })).toThrow('METRO_HTTP_PORT');
  });

  test('defaults to loopback on 8430 and signs for mcp.metro.box', () => {
    const config = readMcpConfig({ DATABASE_URL: 'postgres://db', METRO_CONNECTORS_KEY: KEY });
    expect(config).toMatchObject({ host: '127.0.0.1', port: DEFAULT_PORT, publicHost: DEFAULT_PUBLIC_HOST });
    expect(DEFAULT_PORT).toBe(8430);
    expect(readMcpConfig({ DATABASE_URL: 'postgres://db', METRO_CONNECTORS_KEY: KEY, METRO_HTTP_HOST: '0.0.0.0', METRO_HTTP_PORT: '9000', METRO_MCP_HOST: 'MCP.Staging.Example' })).toMatchObject({ host: '0.0.0.0', port: 9000, publicHost: 'mcp.staging.example' });
  });
});
