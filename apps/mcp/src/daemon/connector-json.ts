import type { ConnectorTransport } from '../db/schema.js';

export interface ConnectorEntry {
  name: string;
  url: string;
  transport: ConnectorTransport;
  header: string | null;
  secret: string | null;
}

function serverOf(entry: ConnectorEntry): Record<string, unknown> {
  const base = { type: entry.transport, url: entry.url };
  const { header, secret } = entry;
  if (header === null || secret === null) return base;
  return { ...base, headers: { [header]: secret } };
}

export function mcpServersJson(entries: ConnectorEntry[]): string {
  const mcpServers: Record<string, unknown> = {};
  for (const entry of entries) mcpServers[entry.name] = serverOf(entry);
  return JSON.stringify({ mcpServers }, null, 2);
}
