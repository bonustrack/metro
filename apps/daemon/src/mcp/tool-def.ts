import type { ToolGroup } from '@metro-labs/core/stations/types';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  group?: ToolGroup;
  destructive?: boolean;
}
