import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type AccountGroup, parseListAccounts } from './accounts';

export class AuthError extends Error {}

function endpoint(apiKey: string): URL {
  const base = import.meta.env.VITE_METRO_MCP_URL ?? '/mcp';
  const url = new URL(base, window.location.origin);
  url.searchParams.set('token', apiKey);
  return url;
}

function isAuthFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\b401\b|unauthorized/i.test(message);
}

export async function fetchAccounts(apiKey: string): Promise<AccountGroup[]> {
  const client = new Client({ name: 'metro-ui', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(endpoint(apiKey));
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'list_accounts', arguments: {} });
    return parseListAccounts(result);
  } catch (err) {
    if (isAuthFailure(err)) throw new AuthError('invalid API key');
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    await client.close().catch(() => undefined);
  }
}
