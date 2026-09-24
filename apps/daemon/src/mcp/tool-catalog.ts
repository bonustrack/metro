import type { GroupOp, Station, StationTool, ToolGroup } from '@metro-labs/core/stations/types';
import { STATIONS } from '../stations/registry.js';
import { COMMON_TOOLS, LIST_ACCOUNTS_TOOL } from './tool-schemas.js';
import { SET_PROFILE_TOOL } from './profile-tool.js';
import { GET_PROFILE_TOOL } from './profile-lookup.js';
import type { ToolDef } from './tool-def.js';

const defOf = (tool: StationTool): ToolDef => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
  ...(tool.group === undefined ? {} : { group: tool.group }),
  ...(tool.destructive === true ? { destructive: true } : {}),
});

export const TOOL_DEFS: ToolDef[] = [
  ...COMMON_TOOLS,
  ...STATIONS.flatMap((s) => s.tools.map(defOf)),
  LIST_ACCOUNTS_TOOL,
  SET_PROFILE_TOOL,
  GET_PROFILE_TOOL,
];

const BY_NAME = new Map(TOOL_DEFS.map((d) => [d.name, d] as const));

export const declaredGroup = (name: string): ToolGroup | undefined => BY_NAME.get(name)?.group;

export const toolGroupOf = (name: string): ToolGroup => declaredGroup(name) ?? 'write';

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
}

export interface PublishedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
}

const annotationsOf = (def: ToolDef): ToolAnnotations =>
  toolGroupOf(def.name) === 'read'
    ? { readOnlyHint: true }
    : { readOnlyHint: false, destructiveHint: def.destructive === true };

export const listedTools = (): PublishedTool[] =>
  TOOL_DEFS.map((def) => ({
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    annotations: annotationsOf(def),
  }));

const STATION_OF_TOOL = new Map(STATIONS.flatMap((s) => s.tools.map((t) => [t.name, s.name] as const)));

export const stationToolOwners = (): Record<string, string> => Object.fromEntries(STATION_OF_TOOL);

export function stationForTool(name: string, args: Record<string, unknown>): string | undefined {
  if (name === 'create_group' || name === 'set_profile')
    return typeof args.station === 'string' && args.station !== '' ? args.station : undefined;
  return STATION_OF_TOOL.get(name);
}

const GROUP_OP_TOOLS: Record<GroupOp, string> = {
  create_group: 'create_group',
  add_members: 'add_members',
  remove_members: 'remove_members',
  invite_link: 'export_invite',
};

export interface GroupedTool {
  name: string;
  group: ToolGroup;
}

export const stationToolGroups = (): Record<string, GroupedTool[]> =>
  Object.fromEntries(STATIONS.filter((s) => s.hasAccounts).map((s) => [s.name, channelToolsOf(s)]));

export function channelToolsOf(station: Station): GroupedTool[] {
  const names: string[] = [...station.messageVerbs];
  if (station.hasTrain && station.hasAccounts) names.push('list_members');
  for (const op of station.groupOps ?? []) names.push(GROUP_OP_TOOLS[op]);
  if ((station.profileFields?.size ?? 0) > 0) names.push('set_profile');
  if (station.readsProfiles === true) names.push('get_profile');
  names.push(...station.tools.map((t) => t.name));
  return names.map((name) => ({ name, group: toolGroupOf(name) }));
}
