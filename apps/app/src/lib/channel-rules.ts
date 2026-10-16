import { effectiveAccess, groupAccess, toolOverride, withGroup, withTool, type Access, type GroupedTool, type ToolGroup, type ToolPolicy } from '@metro-labs/client/api/policy';
import { CHOICE_WORD, GROUP_WORD, accessOfChoice, choiceOfAccess, type PermissionChoice, type PermissionValue } from './permission-words.js';
import { toolLabel } from './tool-labels.js';

export type RowTarget = 'read' | 'write' | 'delete';
export type RuleTarget = RowTarget | `exceptions/${string}`;
export type RuleChoice = PermissionChoice | 'same';

const DELETE_TOOLS = new Set(['delete', 'remove_members', 'close_channel']);
const EXCEPTIONS = 'exceptions/';
const SAMPLE_ID = 'kqfmz';

const ROW_NOTE: Record<RowTarget, string> = {
  read: 'Read messages and history, look up people',
  write: 'Send, reply, react and show typing',
  delete: 'Delete messages or remove people',
};

const PREVIEW_TOOL: Record<RowTarget, string> = { read: 'read', write: 'send', delete: 'delete' };

export interface RuleRow {
  target: RowTarget;
  label: string;
  note: string;
  value: PermissionValue;
  follows: boolean;
}

export const isDeleteTool = (name: string): boolean => DELETE_TOOLS.has(name);

export function listedTools(policy: ToolPolicy, tools: GroupedTool[]): GroupedTool[] {
  const known = new Set(tools.map((tool) => tool.name));
  const saved = Object.keys(policy.tools ?? {}).filter((name) => !known.has(name));
  return [...tools, ...saved.map((name): GroupedTool => ({ name, group: 'write' }))];
}

const deleteTools = (policy: ToolPolicy, tools: GroupedTool[]): GroupedTool[] => listedTools(policy, tools).filter((tool) => isDeleteTool(tool.name));

function deleteValue(policy: ToolPolicy, tools: GroupedTool[]): PermissionValue {
  const overrides = deleteTools(policy, tools).map((tool) => toolOverride(policy, tool.name));
  const first = overrides[0];
  if (overrides.every((access) => access === undefined)) return choiceOfAccess(groupAccess(policy, 'write'));
  return first !== undefined && overrides.every((access) => access === first) ? choiceOfAccess(first) : 'mixed';
}

export function ruleRows(policy: ToolPolicy, tools: GroupedTool[]): RuleRow[] {
  const plain = listedTools(policy, tools).filter((tool) => !isDeleteTool(tool.name));
  const groups: ToolGroup[] = ['read', 'write'];
  const rows: RuleRow[] = groups
    .filter((group) => plain.some((tool) => tool.group === group))
    .map((group) => ({ target: group, label: GROUP_WORD[group], note: ROW_NOTE[group], value: choiceOfAccess(groupAccess(policy, group)), follows: false }));
  const deleting = deleteTools(policy, tools);
  if (deleting.length === 0) return rows;
  return [
    ...rows,
    { target: 'delete', label: GROUP_WORD.delete, note: ROW_NOTE.delete, value: deleteValue(policy, tools), follows: deleting.every((tool) => toolOverride(policy, tool.name) === undefined) },
  ];
}

export const exceptionTools = (policy: ToolPolicy, tools: GroupedTool[]): GroupedTool[] =>
  listedTools(policy, tools).filter((tool) => !isDeleteTool(tool.name));

export const overriddenTools = (policy: ToolPolicy, tools: GroupedTool[]): GroupedTool[] =>
  exceptionTools(policy, tools).filter((tool) => toolOverride(policy, tool.name) !== undefined);

export function exceptionSummary(policy: ToolPolicy, tools: GroupedTool[]): string {
  const own = overriddenTools(policy, tools);
  const first = own[0];
  if (first === undefined) return 'Every tool follows its row';
  if (own.length > 1) return `${String(own.length)} tools have their own rule`;
  return `${toolLabel(first.name)} has its own rule: ${CHOICE_WORD[choiceOfAccess(toolOverride(policy, first.name) ?? 'allow')]}`;
}

export const changedCount = (policy: ToolPolicy, tools: GroupedTool[]): string | undefined => {
  const own = overriddenTools(policy, tools).length;
  return own === 0 ? undefined : `${String(own)} changed`;
};

export interface ToolRule {
  tool: GroupedTool;
  value: PermissionChoice;
  own: boolean;
  listed: boolean;
}

export function toolRules(policy: ToolPolicy, tools: GroupedTool[], group: ToolGroup): ToolRule[] {
  const known = new Set(tools.map((tool) => tool.name));
  return exceptionTools(policy, tools)
    .filter((tool) => tool.group === group)
    .map((tool) => ({ tool, value: choiceOfAccess(effectiveAccess(policy, tool)), own: toolOverride(policy, tool.name) !== undefined, listed: known.has(tool.name) }));
}

export const ruleTarget = (rule: string): RuleTarget | null =>
  rule === 'read' || rule === 'write' || rule === 'delete' ? rule : rule.startsWith(EXCEPTIONS) && rule.length > EXCEPTIONS.length ? `${EXCEPTIONS}${rule.slice(EXCEPTIONS.length)}` : null;

export const toolTarget = (name: string): RuleTarget => `${EXCEPTIONS}${name}`;

export const targetTool = (target: RuleTarget): string | null => (target.startsWith(EXCEPTIONS) ? target.slice(EXCEPTIONS.length) : null);

export function withChoice(policy: ToolPolicy, tools: GroupedTool[], target: RuleTarget, choice: RuleChoice): ToolPolicy {
  const access: Access | undefined = choice === 'same' ? undefined : accessOfChoice(choice);
  if (target === 'read' || target === 'write') return withGroup(policy, target, access);
  const name = targetTool(target);
  if (name !== null) return withTool(policy, name, access);
  return deleteTools(policy, tools).reduce((next, tool) => withTool(next, tool.name, access), policy);
}

export interface AskWhere {
  chat: boolean;
  approvers: number;
}

export function askNote(target: RowTarget, where: AskWhere): string {
  if (!where.chat) return 'Questions show on Home. Email does not carry them.';
  if (where.approvers === 0) return 'Questions show on Home: nobody here can approve yet.';
  return `They get: "Approval needed: ${PREVIEW_TOOL[target]}. Reply yes ${SAMPLE_ID} or no ${SAMPLE_ID}"`;
}
