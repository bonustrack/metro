import type { ToolResult } from '@metro-labs/core/stations/types';
import { errResult } from './ctx.js';

export interface ConnectorToolEntry {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations?: unknown;
}

export interface ConnectorToolProvider {
  list: () => ConnectorToolEntry[];
  owns: (name: string) => boolean;
  call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
}

const NONE: ConnectorToolProvider = {
  list: () => [],
  owns: () => false,
  call: (name) => Promise.resolve(errResult(`metro: no connector serves ${name}`)),
};

let provider: ConnectorToolProvider = NONE;

export function setConnectorToolProvider(next: ConnectorToolProvider | null): void {
  provider = next ?? NONE;
}

export const connectorToolList = (): ConnectorToolEntry[] => provider.list();
export const isConnectorTool = (name: string): boolean => provider.owns(name);
export const callConnectorTool = (name: string, args: Record<string, unknown>): Promise<ToolResult> => provider.call(name, args);
