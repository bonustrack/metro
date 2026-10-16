import type { ConnectorTool } from '@metro-labs/client/api/connectors';
import { effectiveAccess, groupAccess, stricterAccess, withGroup, withTool, type Access, type ToolGroup, type ToolPolicy } from '@metro-labs/client/api/policy';
import { PERMISSION_CHOICES, accessOfChoice, choiceOfAccess, groupValue, type PermissionChoice, type PermissionValue } from './permission-words.js';

export interface ExplorerTool extends ConnectorTool {
  group: ToolGroup;
  listed: boolean;
}

export interface RuleScope {
  policy: ToolPolicy;
  organization?: ToolPolicy;
}

export type ToolFilter = 'all' | 'read' | 'write' | 'changed';

export const TOOL_GROUPS: readonly ToolGroup[] = ['read', 'write'];

export const TOOL_FILTERS: readonly ToolFilter[] = ['all', 'read', 'write', 'changed'];

export const FILTER_WORD: Record<ToolFilter, string> = { all: 'All', read: 'Read', write: 'Write', changed: 'Changed' };

const unlisted = (name: string): ExplorerTool => ({
  name, title: name, description: '', readOnly: false, destructive: false, openWorld: false, inputSchema: null, group: 'write', listed: false,
});

export function explorerTools(tools: readonly ConnectorTool[], policies: readonly ToolPolicy[]): ExplorerTool[] {
  const known = new Set(tools.map((tool) => tool.name));
  const saved = [...new Set(policies.flatMap((policy) => Object.keys(policy.tools ?? {})))].filter((name) => !known.has(name)).sort((a, b) => a.localeCompare(b));
  return [...tools.map((tool): ExplorerTool => ({ ...tool, group: tool.readOnly ? 'read' : 'write', listed: true })), ...saved.map(unlisted)];
}

const rank = (choice: PermissionChoice): number => PERMISSION_CHOICES.indexOf(choice);

const inGroup = (tools: readonly ExplorerTool[], group: ToolGroup): ExplorerTool[] => tools.filter((tool) => tool.group === group);

export const orgChoice = (organization: ToolPolicy, tool: ExplorerTool): PermissionChoice => choiceOfAccess(effectiveAccess(organization, tool));

export function toolChoice(scope: RuleScope, tool: ExplorerTool): PermissionChoice {
  const own = effectiveAccess(scope.policy, tool);
  return choiceOfAccess(scope.organization === undefined ? own : stricterAccess(effectiveAccess(scope.organization, tool), own));
}

export const toolFloor = (scope: RuleScope, tool: ExplorerTool): PermissionChoice | null => (scope.organization === undefined ? null : orgChoice(scope.organization, tool));

export function groupChoice(scope: RuleScope, tools: readonly ExplorerTool[], group: ToolGroup): PermissionValue {
  return groupValue(inGroup(tools, group).map((tool) => toolChoice(scope, tool)));
}

export function groupFloor(scope: RuleScope, tools: readonly ExplorerTool[], group: ToolGroup): PermissionChoice | null {
  const { organization } = scope;
  if (organization === undefined) return null;
  const floors = inGroup(tools, group).map((tool) => orgChoice(organization, tool));
  return floors.reduce<PermissionChoice | null>((loosest, choice) => (loosest === null || rank(choice) < rank(loosest) ? choice : loosest), null);
}

export function withToolChoice(scope: RuleScope, tool: ExplorerTool, choice: PermissionChoice): ToolPolicy {
  const access = accessOfChoice(choice);
  const ownGroup = groupAccess(scope.policy, tool.group);
  const followed = scope.organization === undefined ? ownGroup : stricterAccess(effectiveAccess(scope.organization, tool), ownGroup);
  return withTool(scope.policy, tool.name, access === followed ? undefined : access);
}

function groupStored(scope: RuleScope, members: ExplorerTool[], access: Access): Access | undefined {
  const { organization } = scope;
  if (organization === undefined) return access === 'allow' ? undefined : access;
  const followsOrganization = members.every((tool) => stricterAccess(effectiveAccess(organization, tool), access) === effectiveAccess(organization, tool));
  return followsOrganization ? undefined : access;
}

export function withGroupChoice(scope: RuleScope, tools: readonly ExplorerTool[], group: ToolGroup, choice: PermissionChoice): ToolPolicy {
  const members = inGroup(tools, group);
  const start = withGroup(scope.policy, group, groupStored(scope, members, accessOfChoice(choice)));
  return members.reduce((policy, tool) => withTool(policy, tool.name, undefined), start);
}

export function isChanged(scope: RuleScope, tool: ExplorerTool): boolean {
  const choice = toolChoice(scope, tool);
  return scope.organization === undefined ? choice !== 'allow' : choice !== orgChoice(scope.organization, tool);
}

const matches = (tool: ExplorerTool, query: string): boolean => {
  const words = query.trim().toLowerCase();
  return words === '' || [tool.title, tool.name, tool.description].some((text) => text.toLowerCase().includes(words));
};

export function filterTools(tools: readonly ExplorerTool[], scope: RuleScope, filter: ToolFilter, query: string): ExplorerTool[] {
  return tools.filter((tool) => {
    if (!matches(tool, query)) return false;
    if (filter === 'changed') return isChanged(scope, tool);
    return filter === 'all' || tool.group === filter;
  });
}

export function filterCounts(tools: readonly ExplorerTool[], scope: RuleScope): Record<ToolFilter, number> {
  return {
    all: tools.length,
    read: inGroup(tools, 'read').length,
    write: inGroup(tools, 'write').length,
    changed: tools.filter((tool) => isChanged(scope, tool)).length,
  };
}

export function visibleFilters(counts: Record<ToolFilter, number>, current: ToolFilter): ToolFilter[] {
  return TOOL_FILTERS.filter((filter) => filter === 'all' || filter === current || counts[filter] > 0);
}

export interface AgentPolicy {
  id: string;
  policy: ToolPolicy;
}

export interface StricterAgent {
  id: string;
  choice: PermissionChoice;
}

export function stricterAgents(organization: ToolPolicy, agents: readonly AgentPolicy[], tool: ExplorerTool): StricterAgent[] {
  const floor = orgChoice(organization, tool);
  return agents.flatMap((agent) => {
    const choice = toolChoice({ policy: agent.policy, organization }, tool);
    return choice === floor ? [] : [{ id: agent.id, choice }];
  });
}
