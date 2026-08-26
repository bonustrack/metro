export interface RelayServerEntry {
  id: string;
  name: string;
}

export const NAME_PREFIX = 'metro.box ';

export function relayServersJson(
  entries: RelayServerEntry[],
  base: string,
  cliToken: string,
): string {
  const mcpServers: Record<string, unknown> = {};
  for (const entry of entries)
    mcpServers[`${NAME_PREFIX}${entry.name}`] = {
      type: 'http',
      url: `${base}/relay/${entry.id}`,
      headers: { Authorization: `Bearer ${cliToken}` },
    };
  return JSON.stringify({ mcpServers }, null, 2);
}
