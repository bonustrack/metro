import { isRecord, str } from '../read.js';

interface Named {
  id: string;
  name: string;
}

export function connectorLabel(connector: Named, peers?: readonly Named[]): string {
  const name = connector.name.trim().toLowerCase();
  if (peers !== undefined && !peers.some((row) => row.id !== connector.id && row.name.trim().toLowerCase() === name)) return connector.name;
  return `${connector.name} (${connector.id})`;
}

export function connectorHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'Address withheld';
  }
}

export interface ConnectorTool {
  name: string;
  title: string;
  description: string;
  readOnly: boolean;
}

export function connectorToolsOf(body: unknown): ConnectorTool[] {
  if (!isRecord(body) || !Array.isArray(body.tools)) throw new Error('Metro returned an unexpected response.');
  return body.tools.flatMap((t: unknown) =>
    isRecord(t) && typeof t.name === 'string'
      ? [{ name: t.name, title: str(t.title) === '' ? t.name : str(t.title), description: str(t.description), readOnly: t.readOnly === true }]
      : [],
  );
}
