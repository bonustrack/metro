import { allowsEveryone, EVERYONE } from './accounts.js';
import type { ConnectorTool } from './connectors.js';
import { isMailbox } from './mail-move.js';
import { effectiveAccess, groupAccess, stricterAccess, withTool, type Access, type GroupedTool, type ToolGroup, type ToolPolicy } from './policy.js';

const SENDER_MAX = 200;
const SENDERS_MAX = 500;
const DOMAIN_RE = /^@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const GROUPS: readonly ToolGroup[] = ['read', 'write'];

export const MAIL_CHANNEL_TOOLS: readonly GroupedTool[] = [
  { name: 'send', group: 'write' },
  { name: 'reply', group: 'write' },
  { name: 'read', group: 'read' },
  { name: 'list_members', group: 'read' },
  { name: 'list_channels', group: 'read' },
];

const MAIL_CONNECTOR_TOOLS: readonly MoveTool[] = [
  { name: 'read', group: 'read', title: 'Read mail' },
  { name: 'send', group: 'write', title: 'Send an email' },
  { name: 'reply', group: 'write', title: 'Reply to an email' },
];

export interface MoveTool extends GroupedTool {
  title: string;
}

export const moveTools = (tools: readonly ConnectorTool[] | null): readonly MoveTool[] =>
  tools === null || tools.length === 0 ? MAIL_CONNECTOR_TOOLS : tools.map((tool) => ({ name: tool.name, title: tool.title, group: tool.readOnly ? 'read' : 'write' }));

export interface SendersMove {
  senders: string[];
  dropped: string[];
  nobody: boolean;
}

function carriedEntry(entry: string): string | null {
  const value = entry.trim().toLowerCase();
  if (value.length > SENDER_MAX || /\p{Cc}/u.test(value)) return null;
  if (value.startsWith('@')) return DOMAIN_RE.test(value) ? value : null;
  return isMailbox(value) ? value : null;
}

export function sendersMove(allowlist: string[] | null): SendersMove {
  if (allowsEveryone(allowlist)) return { senders: [EVERYONE], dropped: [], nobody: false };
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const entry of (allowlist ?? []).filter((one) => one.trim() !== '')) {
    const value = carriedEntry(entry);
    if (value === null) dropped.push(entry.trim());
    else if (!kept.includes(value)) kept.push(value);
  }
  const senders = kept.slice(0, SENDERS_MAX);
  return { senders, dropped: [...dropped, ...kept.slice(SENDERS_MAX)], nobody: senders.length === 0 };
}

const RANK: readonly Access[] = ['allow', 'ask', 'deny'];

const stricterThan = (left: Access, right: Access): boolean => RANK.indexOf(left) > RANK.indexOf(right);

const strictestOf = (rules: readonly Access[]): Access => rules.reduce<Access>((worst, rule) => stricterAccess(worst, rule), 'allow');

function policyFrom(groups: Record<ToolGroup, Access>, rules: readonly { tool: GroupedTool; access: Access }[]): ToolPolicy {
  const start: ToolPolicy = {};
  for (const group of GROUPS) if (groups[group] !== 'allow') start[group] = groups[group];
  return rules.reduce((policy, rule) => (rule.access === groups[rule.tool.group] ? policy : withTool(policy, rule.tool.name, rule.access)), start);
}

function withUnlisted(tools: readonly GroupedTool[], policies: readonly ToolPolicy[]): GroupedTool[] {
  const known = new Set(tools.map((tool) => tool.name));
  const saved = [...new Set(policies.flatMap((policy) => Object.keys(policy.tools ?? {})))].filter((name) => !known.has(name)).sort();
  return [...tools, ...saved.map((name): GroupedTool => ({ name, group: 'write' }))];
}

export function stricterPolicy(left: ToolPolicy, right: ToolPolicy, tools: readonly GroupedTool[]): ToolPolicy {
  const groups = { read: stricterAccess(groupAccess(left, 'read'), groupAccess(right, 'read')), write: stricterAccess(groupAccess(left, 'write'), groupAccess(right, 'write')) };
  const rules = withUnlisted(tools, [left, right]).map((tool) => ({ tool, access: stricterAccess(effectiveAccess(left, tool), effectiveAccess(right, tool)) }));
  return policyFrom(groups, rules);
}

export function sameRules(left: ToolPolicy, right: ToolPolicy, tools: readonly GroupedTool[]): boolean {
  if (GROUPS.some((group) => groupAccess(left, group) !== groupAccess(right, group))) return false;
  return withUnlisted(tools, [left, right]).every((tool) => effectiveAccess(left, tool) === effectiveAccess(right, tool));
}

interface Mapped {
  tool: MoveTool;
  before: Access;
  access: Access;
  folded: string[];
}

function mappedRules(channel: ToolPolicy, channelTools: readonly GroupedTool[], tools: readonly MoveTool[]): { groups: Record<ToolGroup, Access>; rules: Mapped[] } {
  const orphans = channelTools.filter((tool) => !tools.some((known) => known.name === tool.name)).map((tool) => ({ tool, access: effectiveAccess(channel, tool) }));
  const orphaned = (group: ToolGroup): { tool: GroupedTool; access: Access }[] => orphans.filter((orphan) => orphan.tool.group === group);
  const groups = { read: strictestOf([groupAccess(channel, 'read'), ...orphaned('read').map((one) => one.access)]), write: strictestOf([groupAccess(channel, 'write'), ...orphaned('write').map((one) => one.access)]) };
  const rules = tools.map((tool): Mapped => {
    const twin = channelTools.find((known) => known.name === tool.name);
    const before = twin === undefined ? groupAccess(channel, tool.group) : effectiveAccess(channel, twin);
    const stricter = orphaned(tool.group).filter((orphan) => stricterThan(orphan.access, before));
    return { tool, before, access: strictestOf([before, ...stricter.map((one) => one.access)]), folded: stricter.map((one) => one.tool.name) };
  });
  return { groups, rules };
}

export type RuleReason = 'same' | 'folded' | 'assignment' | 'organization';

export interface RuleMove {
  tool: string;
  title: string;
  before: Access;
  after: Access;
  reason: RuleReason;
  folded: string[];
}

export interface MovePlan {
  senders: SendersMove;
  receive: boolean;
  policy: ToolPolicy;
  rules: RuleMove[];
}

export interface MoveInput {
  allowlist: string[] | null;
  policy: ToolPolicy;
  receiving: boolean;
  channelTools: readonly GroupedTool[];
  tools: readonly MoveTool[];
  organization: ToolPolicy;
  assigned: ToolPolicy | null;
}

function reasonOf(rule: Mapped, merged: Access, after: Access): RuleReason {
  if (after === rule.before) return 'same';
  if (after === rule.access) return 'folded';
  return after === merged ? 'assignment' : 'organization';
}

export function movePlan(input: MoveInput): MovePlan {
  const channelTools = input.channelTools.length === 0 ? MAIL_CHANNEL_TOOLS : input.channelTools;
  const mapped = mappedRules(input.policy, channelTools, input.tools);
  const carried = policyFrom(mapped.groups, mapped.rules);
  const policy = input.assigned === null ? carried : stricterPolicy(input.assigned, carried, input.tools);
  const senders = sendersMove(input.allowlist);
  const rules = mapped.rules.map((rule): RuleMove => {
    const merged = effectiveAccess(policy, rule.tool);
    const after = stricterAccess(effectiveAccess(input.organization, rule.tool), merged);
    return { tool: rule.tool.name, title: rule.tool.title, before: rule.before, after, reason: reasonOf(rule, merged, after), folded: rule.folded };
  });
  return { senders, receive: input.receiving && !senders.nobody, policy, rules };
}

const sameList = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every((entry) => right.includes(entry));

export interface CarriedCheck {
  policy: ToolPolicy;
  senders: string[];
}

export const rulesCarried = (plan: MovePlan, held: CarriedCheck, tools: readonly GroupedTool[]): boolean => sameRules(plan.policy, held.policy, tools);

export const sendersCarried = (plan: MovePlan, held: CarriedCheck): boolean => plan.senders.nobody || sameList(plan.senders.senders, held.senders);

export const settingsCarried = (plan: MovePlan, held: CarriedCheck | undefined, tools: readonly GroupedTool[]): boolean =>
  held !== undefined && rulesCarried(plan, held, tools) && sendersCarried(plan, held);
