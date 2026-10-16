import { groupAccess, type Access, type ToolGroup, type ToolPolicy } from '@metro-labs/client/api/policy';
import type { Tone } from './tone.js';

export const RULE_WORD: Record<Access, string> = { allow: 'Allowed', ask: 'Asks first', deny: 'Not allowed' };

export const RULE_TONE: Record<Access, Tone> = { allow: 'success', ask: 'default', deny: 'danger' };

export const RULE_NOTE: Record<Access, string> = {
  allow: 'Agents use these tools without asking.',
  ask: 'Agents ask you in chat or on Home first, then wait for your answer.',
  deny: 'Agents cannot use these tools at all.',
};

export const CONNECTOR_GROUP: Record<ToolGroup, string> = { read: 'Read', write: 'Change' };

export const CONNECTOR_GROUP_NOTE: Record<ToolGroup, string> = {
  read: 'Tools the service marks as read-only.',
  write: 'Tools that create, change or delete, and any tool not marked read-only.',
};

const GROUPS: readonly ToolGroup[] = ['read', 'write'];

export function exceptionNames(policy: ToolPolicy): string[] {
  return Object.keys(policy.tools ?? {}).sort((a, b) => a.localeCompare(b));
}

export function exceptionsLine(policy: ToolPolicy, titles: Record<string, string>): string {
  const names = exceptionNames(policy);
  if (names.length === 0) return 'None. Every tool follows its group.';
  if (names.length > 1) return `${String(names.length)} tools have their own rule`;
  const name = names[0] ?? '';
  const access = policy.tools?.[name] ?? 'allow';
  return `${titles[name] ?? name} is ${RULE_WORD[access].toLowerCase()}`;
}

export interface RulePart {
  label: string;
  access: Access;
}

export function ownRuleParts(policy: ToolPolicy): RulePart[] {
  return GROUPS.flatMap((group) => (policy[group] === undefined ? [] : [{ label: CONNECTOR_GROUP[group], access: groupAccess(policy, group) }]));
}

export function ownRuleLine(policy: ToolPolicy): string {
  const parts = ownRuleParts(policy);
  const tools = exceptionNames(policy).length;
  if (parts.length === 0 && tools === 0) return 'Follows the rule above';
  const groups = parts.map((part) => `${part.label} ${RULE_WORD[part.access].toLowerCase()}`);
  const extra = tools === 0 ? [] : [`${String(tools)} ${tools === 1 ? 'tool' : 'tools'} of its own`];
  return `Own rule: ${[...groups, ...extra].join(', ')}`;
}
