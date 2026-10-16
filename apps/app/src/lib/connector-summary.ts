import { groupAccess, stricterAccess, type ToolGroup, type ToolPolicy } from '@metro-labs/client/api/policy';
import { CHOICE_WORD, choiceOfAccess, type PermissionChoice } from './permission-words.js';
import { TOOL_GROUPS, isChanged, type ExplorerTool } from './connector-rules.js';

export interface SummaryPart {
  label: string;
  choice: PermissionChoice;
}

export type RuleSummary = { kind: 'same' } | { kind: 'groups'; parts: SummaryPart[] } | { kind: 'tools'; count: number };

const GROUP_LABEL: Record<ToolGroup, string> = { read: 'Read', write: 'Write' };

const ownTools = (own: ToolPolicy): string[] => Object.keys(own.tools ?? {});

function groupParts(own: ToolPolicy, tools: readonly ExplorerTool[] | null): SummaryPart[] {
  const overridden = new Set(ownTools(own));
  return TOOL_GROUPS.flatMap((group) => {
    const access = own[group];
    if (access === undefined || access === 'allow') return [];
    if (tools !== null && tools.some((tool) => tool.group === group && overridden.has(tool.name))) return [];
    return [{ label: GROUP_LABEL[group], choice: choiceOfAccess(access) }];
  });
}

function fromPolicy(own: ToolPolicy): RuleSummary {
  const count = ownTools(own).length;
  if (count > 0) return { kind: 'tools', count };
  const parts = groupParts(own, null);
  return parts.length === 0 ? { kind: 'same' } : { kind: 'groups', parts };
}

export function agentRuleSummary(organization: ToolPolicy, own: ToolPolicy, tools: readonly ExplorerTool[] | null): RuleSummary {
  if (tools === null) return fromPolicy(own);
  const stricter = tools.filter((tool) => isChanged({ policy: own, organization }, tool));
  if (stricter.length === 0) return { kind: 'same' };
  const parts = groupParts(own, tools);
  const covered = new Set(parts.map((part) => part.label));
  if (parts.length > 0 && stricter.every((tool) => covered.has(GROUP_LABEL[tool.group]))) return { kind: 'groups', parts };
  return { kind: 'tools', count: stricter.length };
}

export const partText = (part: SummaryPart): string => `${part.label}: ${CHOICE_WORD[part.choice]}`;

export function summaryText(summary: RuleSummary): string {
  if (summary.kind === 'same') return 'Same as the organization';
  if (summary.kind === 'groups') return summary.parts.map(partText).join(' · ');
  return `Stricter on ${String(summary.count)} ${summary.count === 1 ? 'tool' : 'tools'}`;
}

export interface EffectiveRule {
  parts: SummaryPart[];
  tools: number;
}

export function effectiveRule(organization: ToolPolicy, own: ToolPolicy): EffectiveRule {
  const parts = TOOL_GROUPS.map((group) => ({ label: GROUP_LABEL[group], choice: choiceOfAccess(stricterAccess(groupAccess(organization, group), groupAccess(own, group))) }));
  const tools = new Set([...Object.keys(organization.tools ?? {}), ...ownTools(own)]).size;
  return { parts, tools };
}

export const toolRulesText = (count: number): string => (count === 1 ? '1 tool has its own rule' : `${String(count)} tools have their own rule`);
