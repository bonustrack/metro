import type { ConnectorTransport } from '../db/schema.js';

export interface ConnectorEntry {
  name: string;
  url: string;
  transport: ConnectorTransport;
  header: string | null;
  secret: string | null;
  bearer: string | null;
}

function headersOf(entry: ConnectorEntry): Record<string, string> | null {
  const { header, secret, bearer } = entry;
  if (typeof header === 'string' && typeof secret === 'string')
    return { [header]: secret };
  if (typeof bearer === 'string' && bearer !== '')
    return { Authorization: `Bearer ${bearer}` };
  return null;
}

function serverOf(entry: ConnectorEntry): Record<string, unknown> {
  const base = { type: entry.transport, url: entry.url };
  const headers = headersOf(entry);
  return headers === null ? base : { ...base, headers };
}

export function mcpServersJson(entries: ConnectorEntry[]): string {
  const mcpServers: Record<string, unknown> = {};
  for (const entry of entries) mcpServers[entry.name] = serverOf(entry);
  return JSON.stringify({ mcpServers }, null, 2);
}
