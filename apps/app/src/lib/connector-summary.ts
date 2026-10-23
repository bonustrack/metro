import type { ConnectorTool } from '@metro-labs/client/api/connectors';
import type { OrgConnector } from '@metro-labs/client/api/org-connectors';
import { groupAccess, stricterAccess, type ToolGroup, type ToolPolicy } from '@metro-labs/client/api/policy';
import { orgConnectorStatus } from '../components/org-connector-status.js';
import { CHOICE_WORD, choiceOfAccess, type PermissionChoice, type PermissionGroup } from './permission-words.js';
import { TOOL_GROUPS, explorerTools, isChanged, toolChoice, type ExplorerTool } from './connector-rules.js';
import {
  asksAnywhere, countWords, ownRules, ownRulesSentence, paragraph, rulesClause, txt, unanimous, val, type GroupBases, type GroupWords, type RuledTool, type Segment,
} from './rule-sentence.js';

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

export interface ConnectorFacts {
  agent: string;
  agentId: string;
  connector: OrgConnector;
  tools: readonly ConnectorTool[] | null;
  remote: boolean;
}

const CONNECTOR_WORDS: Record<PermissionGroup, GroupWords> = {
  read: { does: 'looks things up', ask: 'lookups', cannot: 'look things up' },
  write: { does: 'makes changes', ask: 'changes', cannot: 'make changes' },
  delete: { does: 'deletes', ask: 'deletions', cannot: 'delete' },
};

const permissionGroup = (tool: ExplorerTool): PermissionGroup => (tool.group === 'read' ? 'read' : tool.destructive ? 'delete' : 'write');

function basesOf(organization: ToolPolicy, own: ToolPolicy, tools: readonly ExplorerTool[] | null): GroupBases {
  const stored = (group: ToolGroup): PermissionChoice => choiceOfAccess(stricterAccess(groupAccess(organization, group), groupAccess(own, group)));
  if (tools === null) return { read: stored('read'), write: stored('write') };
  const choices = (group: PermissionGroup): PermissionChoice[] => tools.filter((tool) => permissionGroup(tool) === group).map((tool) => toolChoice({ policy: own, organization }, tool));
  const [read, write, del] = [choices('read'), choices('write'), choices('delete')];
  const writeBase = unanimous(write) ?? stored('write');
  return {
    ...(read.length === 0 ? {} : { read: unanimous(read) ?? stored('read') }),
    ...(write.length === 0 ? {} : { write: writeBase }),
    ...(del.length === 0 ? {} : { delete: unanimous(del) ?? writeBase }),
  };
}

function availability({ agent, connector, tools }: ConnectorFacts): Segment[] | null {
  if (orgConnectorStatus(connector).bad) return [val('signed out'), txt(': '), val(agent), txt(' cannot use '), val(connector.name), txt(' until an admin signs in again')];
  if (tools === null) return null;
  return tools.length === 0 ? [txt('no tools listed yet')] : [val(countWords(tools.length, 'tool', 'tools'))];
}

const policyAsks = (policies: readonly ToolPolicy[]): boolean => policies.some((policy) => Object.values(policy.tools ?? {}).includes('ask'));

const approvalsLine = (agent: string, remote: boolean): Segment[] =>
  remote ? [txt('approvals only on '), val(`${agent}'s page`), txt(' on '), val('metro.box')] : [txt('approvals in a '), val('private chat'), txt(' and on '), val('metro.box')];

const countedRules = (count: number): Segment[] | null => (count === 0 ? null : [val(countWords(count, 'tool', 'tools')), txt(count === 1 ? ' has its own rule' : ' have their own rule')]);

export function connectorSummary(facts: ConnectorFacts): Segment[] {
  const { agent, agentId, connector, remote } = facts;
  const held = connector.agents.find((row) => row.id === agentId);
  if (held === undefined) return paragraph([[val(agent), txt(' does not have '), val(connector.name)]]);
  const organization = connector.policy;
  const own = held.policy;
  const tools = facts.tools === null ? null : explorerTools(facts.tools, [own, organization]);
  const bases = basesOf(organization, own, tools);
  const ruled = tools === null ? [] : ownRules(tools.map((tool): RuledTool => ({ label: tool.title, group: permissionGroup(tool), choice: toolChoice({ policy: own, organization }, tool) })), bases);
  const clause = rulesClause(bases, CONNECTOR_WORDS);
  const asks = asksAnywhere(bases, ruled) || (tools === null && policyAsks([organization, own]));
  return paragraph([
    availability(facts),
    clause === null ? null : [val(agent), txt(' '), ...clause],
    tools === null ? countedRules(effectiveRule(organization, own).tools) : ownRulesSentence(ruled),
    asks ? approvalsLine(agent, remote) : null,
  ]);
}
