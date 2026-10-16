import { effectiveAccess, groupAccess, toolOverride, withGroup, withTool, type Access, type GroupedTool, type ToolGroup, type ToolPolicy } from '@metro-labs/client/api/policy';
import { toolLabel } from './tool-labels.js';

export type RowTarget = 'read' | 'write' | 'delete';
export type RuleTarget = RowTarget | `exceptions/${string}`;
export type RuleChoice = Access | 'same';
export type RuleShown = Access | 'mixed';

export const RULE_ACCESS: readonly Access[] = ['allow', 'ask', 'deny'];

export const ACCESS_WORD: Record<Access, string> = { allow: 'Allowed', ask: 'Asks first', deny: 'Not allowed' };

const SHOWN_WORD: Record<RuleShown, string> = { ...ACCESS_WORD, mixed: 'Mixed' };

export const shownWord = (shown: RuleShown): string => SHOWN_WORD[shown];

const DELETE_TOOLS = new Set(['delete', 'remove_members', 'close_channel']);
const EXCEPTIONS = 'exceptions/';

const GROUP_TITLE: Record<ToolGroup, string> = { read: 'Read', write: 'Send and reply' };
const ROW_TITLE: Record<RowTarget, string> = { ...GROUP_TITLE, delete: 'Delete' };

export interface RuleRow {
  target: RowTarget;
  label: string;
  shown: RuleShown;
  follows: boolean;
}

export const isDeleteTool = (name: string): boolean => DELETE_TOOLS.has(name);

export function listedTools(policy: ToolPolicy, tools: GroupedTool[]): GroupedTool[] {
  const known = new Set(tools.map((tool) => tool.name));
  const saved = Object.keys(policy.tools ?? {}).filter((name) => !known.has(name));
  return [...tools, ...saved.map((name): GroupedTool => ({ name, group: 'write' }))];
}

const deleteTools = (policy: ToolPolicy, tools: GroupedTool[]): GroupedTool[] => listedTools(policy, tools).filter((tool) => isDeleteTool(tool.name));

const together = (accesses: Access[]): RuleShown => (accesses.every((access) => access === accesses[0]) ? (accesses[0] ?? 'allow') : 'mixed');

export function ruleRows(policy: ToolPolicy, tools: GroupedTool[]): RuleRow[] {
  const plain = listedTools(policy, tools).filter((tool) => !isDeleteTool(tool.name));
  const groups: ToolGroup[] = ['read', 'write'];
  const rows: RuleRow[] = groups
    .filter((group) => plain.some((tool) => tool.group === group))
    .map((group) => ({ target: group, label: GROUP_TITLE[group], shown: groupAccess(policy, group), follows: false }));
  const deleting = deleteTools(policy, tools);
  if (deleting.length === 0) return rows;
  const mixed = choiceOf(policy, tools, 'delete') === null;
  return [
    ...rows,
    {
      target: 'delete',
      label: ROW_TITLE.delete,
      shown: mixed ? 'mixed' : together(deleting.map((tool) => effectiveAccess(policy, tool))),
      follows: deleting.every((tool) => toolOverride(policy, tool.name) === undefined),
    },
  ];
}

export const exceptionTools = (policy: ToolPolicy, tools: GroupedTool[]): GroupedTool[] =>
  listedTools(policy, tools).filter((tool) => !isDeleteTool(tool.name));

export const overriddenTools = (policy: ToolPolicy, tools: GroupedTool[]): GroupedTool[] =>
  exceptionTools(policy, tools).filter((tool) => toolOverride(policy, tool.name) !== undefined);

const EXCEPTION_PHRASE: Record<Access, string> = { allow: 'is always allowed', ask: 'always asks first', deny: 'is not allowed' };

export function exceptionSummary(policy: ToolPolicy, tools: GroupedTool[]): string {
  const own = overriddenTools(policy, tools);
  const first = own[0];
  if (first === undefined) return 'One tool can have its own rule';
  const access = toolOverride(policy, first.name) ?? 'allow';
  if (own.length === 1) return `${toolLabel(first.name)} ${EXCEPTION_PHRASE[access]}`;
  return `${String(own.length)} tools have their own rule`;
}

export const ruleTarget = (rule: string): RuleTarget | null =>
  rule === 'read' || rule === 'write' || rule === 'delete' ? rule : rule.startsWith(EXCEPTIONS) && rule.length > EXCEPTIONS.length ? `${EXCEPTIONS}${rule.slice(EXCEPTIONS.length)}` : null;

export const toolTarget = (name: string): RuleTarget => `${EXCEPTIONS}${name}`;

export const targetTool = (target: RuleTarget): string | null => (target.startsWith(EXCEPTIONS) ? target.slice(EXCEPTIONS.length) : null);

function groupOf(policy: ToolPolicy, tools: GroupedTool[], target: RuleTarget): ToolGroup {
  if (target === 'read' || target === 'write') return target;
  if (target === 'delete') return 'write';
  const name = targetTool(target);
  return listedTools(policy, tools).find((tool) => tool.name === name)?.group ?? 'write';
}

const rowOf = (target: RuleTarget): RowTarget | null => (target === 'read' || target === 'write' || target === 'delete' ? target : null);

export function ruleTitle(target: RuleTarget): string {
  const row = rowOf(target);
  return row === null ? toolLabel(targetTool(target) ?? target) : ROW_TITLE[row];
}

export const offersSame = (target: RuleTarget): boolean => target !== 'read' && target !== 'write';

export interface SameAs {
  row: string;
  access: Access;
}

export function sameAs(policy: ToolPolicy, tools: GroupedTool[], target: RuleTarget): SameAs {
  const group = groupOf(policy, tools, target);
  return { row: GROUP_TITLE[group], access: groupAccess(policy, group) };
}

export function choiceOf(policy: ToolPolicy, tools: GroupedTool[], target: RuleTarget): RuleChoice | null {
  if (target === 'read' || target === 'write') return groupAccess(policy, target);
  const name = targetTool(target);
  if (name !== null) return toolOverride(policy, name) ?? 'same';
  const overrides = deleteTools(policy, tools).map((tool) => toolOverride(policy, tool.name));
  if (overrides.every((access) => access === undefined)) return 'same';
  const first = overrides[0];
  return first !== undefined && overrides.every((access) => access === first) ? first : null;
}

export const mixedNote = (choice: RuleChoice | null): string | undefined =>
  choice === null ? 'Now Mixed: the delete tools have different rules. Nothing changes until you pick one, and then it applies to all of them.' : undefined;

export function withChoice(policy: ToolPolicy, tools: GroupedTool[], target: RuleTarget, choice: RuleChoice): ToolPolicy {
  const access = choice === 'same' ? undefined : choice;
  if (target === 'read' || target === 'write') return withGroup(policy, target, access);
  const name = targetTool(target);
  if (name !== null) return withTool(policy, name, access);
  return deleteTools(policy, tools).reduce((next, tool) => withTool(next, tool.name, access), policy);
}

export interface RuleText {
  lead: string;
  allow: string;
  ask: string;
  deny: string;
}

export function ruleText(target: RuleTarget, name: string): RuleText {
  if (target === 'read')
    return {
      lead: `When ${name} reads past messages or looks people up here. New messages still arrive.`,
      allow: `${name} reads without asking.`,
      ask: 'Nothing is read until someone says yes.',
      deny: `${name} only sees new messages.`,
    };
  if (target === 'write')
    return {
      lead: `When ${name} sends, replies or reacts here.`,
      allow: `${name} sends without asking.`,
      ask: 'Nothing goes out until someone says yes.',
      deny: `${name} reads but never sends.`,
    };
  if (target === 'delete')
    return {
      lead: `When ${name} deletes a message or removes someone here.`,
      allow: `${name} deletes without asking.`,
      ask: 'Nothing is deleted until someone says yes.',
      deny: `${name} never deletes here.`,
    };
  return {
    lead: 'Only for this tool. Everything else follows the rows of the channel.',
    allow: `${name} does it without asking.`,
    ask: 'It waits until someone says yes.',
    deny: `${name} never does it here.`,
  };
}

const PREVIEW_TOOL: Record<RowTarget, string> = { read: 'read', write: 'send', delete: 'delete' };

const PREVIEW_TEXT: Record<RowTarget, string> = {
  read: 'Read the last 20 messages.',
  write: 'Hi Andy, the contract is signed. I will send it to MCI today.',
  delete: 'Delete the message "See you at 3".',
};

export interface PromptPreview {
  tool: string;
  text: string;
}

export function promptPreview(target: RuleTarget): PromptPreview {
  const row = rowOf(target);
  if (row !== null) return { tool: PREVIEW_TOOL[row], text: PREVIEW_TEXT[row] };
  const name = targetTool(target) ?? target;
  return { tool: name, text: `${toolLabel(name)}.` };
}
