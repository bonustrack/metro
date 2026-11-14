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
  destructive: boolean;
  openWorld: boolean;
  inputSchema: Record<string, unknown> | null;
}

function toolOf(raw: unknown): ConnectorTool[] {
  if (!isRecord(raw) || typeof raw.name !== 'string') return [];
  const title = str(raw.title);
  return [{
    name: raw.name,
    title: title === '' ? raw.name : title,
    description: str(raw.description),
    readOnly: raw.readOnly === true,
    destructive: raw.destructive === true,
    openWorld: raw.openWorld === true,
    inputSchema: isRecord(raw.inputSchema) ? raw.inputSchema : null,
  }];
}

export function connectorToolsOf(body: unknown): ConnectorTool[] {
  if (!isRecord(body) || !Array.isArray(body.tools)) throw new Error('Metro returned an unexpected response.');
  return body.tools.flatMap(toolOf);
}
