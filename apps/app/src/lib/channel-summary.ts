import { allowsEveryone, type AccountRow } from '@metro-labs/client/api/accounts';
import { connectionWords } from '@metro-labs/client/api/pair-again';
import { effectiveAccess, groupAccess, type GroupedTool, type ToolPolicy } from '@metro-labs/client/api/policy';
import { approvesInChat, isDomain, type Person } from './channel-people.js';
import { isDeleteTool, listedTools, ruleRows } from './channel-rules.js';
import { choiceOfAccess, type PermissionGroup } from './permission-words.js';
import {
  cappedList, countWords, joinSegments, ownRules, ownRulesSentence, paragraph, rulesClause, txt, val, type GroupBases, type GroupWords, type Joiner, type RuledTool, type Segment,
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
  read: { does: 'reads', ask: 'reading', cannot: 'read' },
  write: { does: 'sends', ask: 'sending', cannot: 'send' },
  delete: { does: 'deletes', ask: 'deleting', cannot: 'delete' },
};

const PAGE_ONLY: Segment[] = [txt('approvals only on '), val('metro.box')];

const isAddress = (id: string): boolean => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(id);

const isNamed = (person: Person): boolean => person.title !== person.id || isAddress(person.id);

const restWords = (count: number, none: boolean): string => (none ? countWords(count, 'person', 'people') : countWords(count, 'other', 'others'));

function whoWords(people: readonly Person[], joiner: Joiner = 'and'): Segment[] {
  const persons = people.filter((person) => !isDomain(person.id));
  const domains = people.filter((person) => isDomain(person.id)).map((person) => [txt('anyone at '), val(person.id)]);
  const named = cappedList(persons.filter(isNamed).map((person) => person.title), persons.length, restWords).map((name) => [val(name)]);
  return joinSegments([...domains, ...named], joiner);
}

function connectionLine({ label, row, reportsStatus, pairAgain }: ChannelFacts): Segment[] | null {
  const status = row.status;
  if (!reportsStatus || status === null || status.state === 'connected') return null;
  return [txt(`${label} is `), val(connectionWords(status).title.toLowerCase()), txt(status.state === 'logged_out' && pairAgain ? ': pair it again' : '')];
}

function writersLine({ row, people }: ChannelFacts): Segment[] | null {
  if (row.allowlist === null) return null;
  return [...(allowsEveryone(row.allowlist) ? [val('anyone')] : whoWords(people)), txt(' can write')];
}

function approvalsLine({ station, row, people }: ChannelFacts): Segment[] | null {
  if (row.allowlist === null) return null;
  const approvers = people.filter((person) => person.approves === true);
  if (!approvesInChat(station) || !row.enabled || approvers.length === 0) return PAGE_ONLY;
  return [...whoWords(approvers), txt(approvers.length === 1 ? ' approves in a ' : ' approve in a '), val('private chat')];
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

function receivingLine({ agent, row }: ChannelFacts, bases: GroupBases): Segment[] {
  if (row.enabled) return [];
  const sends = bases.write !== undefined && bases.write !== 'block';
  return [val(agent), txt(' gets '), val('no new messages'), txt(sends ? ', but can still send' : '')];
}

function rulesLines(facts: ChannelFacts, bases: GroupBases): (Segment[] | null)[] {
  const { agent, row, tools, verbs, readOnly } = facts;
  if (verbs.length === 0) return [[val(agent), txt(' only receives messages and cannot write')]];
  if (tools.length === 0) return [];
  const clause = rulesClause(bases, CHANNEL_WORDS);
  return [
    clause === null ? null : [val(agent), txt(' '), ...clause],
    readOnly ? [txt('Google access is '), val('read-only'), txt(', so '), val(agent), txt(' cannot send')] : null,
    ownRulesSentence(ownRules(ruledTools(row.policy, tools, bases), bases)),
  ];
}

export function channelSummary(facts: ChannelFacts): Segment[] {
  const bases = facts.verbs.length === 0 ? {} : basesOf(facts.row.policy, facts.tools, facts.readOnly);
  const inbound = facts.row.enabled ? writersLine(facts) : receivingLine(facts, bases);
  return paragraph([connectionLine(facts), inbound, approvalsLine(facts), ...rulesLines(facts, bases)]);
}
