import { allowsEveryone, type AccountRow } from '@metro-labs/client/api/accounts';
import { connectionWords } from '@metro-labs/client/api/pair-again';
import { effectiveAccess, groupAccess, type GroupedTool, type ToolPolicy } from '@metro-labs/client/api/policy';
import { approvesInChat, isDomain, type Person } from './channel-people.js';
import { isDeleteTool, listedTools, ruleRows } from './channel-rules.js';
import { choiceOfAccess, type PermissionGroup } from './permission-words.js';
import {
  cappedList, countWords, joinWords, ownRules, ownRulesSentence, paragraph, rulesClause, type GroupBases, type GroupWords, type Joiner, type RuledTool,
} from './rule-sentence.js';
import { toolLabel } from './tool-labels.js';

export interface ChannelFacts {
  agent: string;
  station: string;
  label: string;
  row: AccountRow;
  tools: GroupedTool[];
  verbs: string[];
  people: Person[];
  reportsStatus: boolean;
  pairAgain: boolean;
  readOnly: boolean;
}

const CHANNEL_WORDS: Record<PermissionGroup, GroupWords> = {
  read: { can: 'read', doing: 'reading' },
  write: { can: 'send', doing: 'sending' },
  delete: { can: 'delete', doing: 'deleting' },
};

const PAGE_ONLY = 'approval questions only show on metro.box';

const isAddress = (id: string): boolean => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(id);

const isNamed = (person: Person): boolean => person.title !== person.id || isAddress(person.id);

const restWords = (count: number, none: boolean): string => (none ? countWords(count, 'person', 'people') : countWords(count, 'other', 'others'));

function whoWords(people: readonly Person[], joiner: Joiner = 'and'): string {
  const persons = people.filter((person) => !isDomain(person.id));
  const domains = people.filter((person) => isDomain(person.id)).map((person) => `anyone at ${person.id}`);
  const named = persons.filter(isNamed).map((person) => person.title);
  return joinWords([...domains, ...cappedList(named, persons.length, restWords)], joiner);
}

function connectionLine({ label, row, reportsStatus, pairAgain }: ChannelFacts): string | null {
  const status = row.status;
  if (!reportsStatus || status === null || status.state === 'connected') return null;
  const fix = status.state === 'logged_out' && pairAgain ? ': pair it again' : '';
  return `${label} is ${connectionWords(status).title.toLowerCase()}${fix}`;
}

function writersLine({ agent, row, people }: ChannelFacts): string | null {
  if (row.allowlist === null) return null;
  if (allowsEveryone(row.allowlist)) return `anyone can write to ${agent} here`;
  const only = people.some((person) => isDomain(person.id)) ? '' : 'only ';
  return `${only}${whoWords(people)} can write to ${agent} here`;
}

function approvalsLine({ station, row, people }: ChannelFacts): string | null {
  if (row.allowlist === null) return null;
  const approvers = people.filter((person) => person.approves === true);
  if (!approvesInChat(station) || !row.enabled || approvers.length === 0) return PAGE_ONLY;
  return `approval questions go to ${whoWords(approvers, 'or')} in a private chat`;
}

function basesOf(policy: ToolPolicy, tools: GroupedTool[], readOnly: boolean): GroupBases {
  const write = choiceOfAccess(groupAccess(policy, 'write'));
  const bases: GroupBases = {};
  for (const row of ruleRows(policy, tools)) {
    if (readOnly && row.target !== 'read') continue;
    bases[row.target] = row.value === 'mixed' || row.value === null ? write : row.value;
  }
  return bases;
}

const ruledTools = (policy: ToolPolicy, tools: GroupedTool[], bases: GroupBases): RuledTool[] =>
  listedTools(policy, tools)
    .map((tool): RuledTool => ({ label: toolLabel(tool.name), group: isDeleteTool(tool.name) ? 'delete' : tool.group, choice: choiceOfAccess(effectiveAccess(policy, tool)) }))
    .filter((tool) => bases[tool.group] !== undefined);

function inboundLines(facts: ChannelFacts, bases: GroupBases): (string | null)[] {
  const approvals = approvalsLine(facts);
  if (facts.row.enabled) {
    const writers = writersLine(facts);
    return [writers === null ? approvals : approvals === null ? writers : `${writers}, and ${approvals}`];
  }
  const sends = bases.write !== undefined && bases.write !== 'block';
  return [`${facts.agent} does not read new messages here${sends ? ', but can still send' : ''}`, approvals];
}

function rulesLines(facts: ChannelFacts, bases: GroupBases): (string | null)[] {
  const { agent, row, tools, verbs, readOnly } = facts;
  if (verbs.length === 0) return [`this channel only brings messages in, so ${agent} cannot write here`];
  if (tools.length === 0) return [];
  const clause = rulesClause(bases, CHANNEL_WORDS);
  const own = ownRulesSentence(ownRules(ruledTools(row.policy, tools, bases), bases));
  return [clause === null ? null : `${agent} ${clause}`, readOnly ? `Google access is read-only, so ${agent} cannot send from this mailbox` : null, own];
}

export function channelSummary(facts: ChannelFacts): string {
  const bases = facts.verbs.length === 0 ? {} : basesOf(facts.row.policy, facts.tools, facts.readOnly);
  return paragraph([connectionLine(facts), ...inboundLines(facts, bases), ...rulesLines(facts, bases)]);
}
