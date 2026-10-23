import { PERMISSION_CHOICES, type PermissionChoice, type PermissionGroup } from './permission-words.js';

export type Joiner = 'and' | 'or';

const LISTED_MAX = 3;
const LISTED_CUT = 2;
const GROUP_ORDER: readonly PermissionGroup[] = ['read', 'write', 'delete'];

export function joinWords(items: readonly string[], joiner: Joiner = 'and'): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} ${joiner} ${items[items.length - 1] ?? ''}`;
}

export const namesList = (names: string[]): string => joinWords(names);

export const toolRulesText = (count: number): string => (count === 1 ? '1 tool has its own rule' : `${String(count)} tools have their own rule`);

export const countWords = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

const capitalized = (text: string): string => (/^\S*@/.test(text) ? text : `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`);

export function paragraph(parts: readonly (string | null)[]): string {
  return parts
    .filter((part): part is string => part !== null && part.trim() !== '')
    .map((part) => {
      const text = capitalized(part.trim());
      return /[.!?]$/.test(text) ? text : `${text}.`;
    })
    .join(' ');
}

export function cappedList(shown: readonly string[], total: number, rest: (count: number, none: boolean) => string): string[] {
  const kept = shown.slice(0, total <= LISTED_MAX ? LISTED_MAX : LISTED_CUT);
  const left = total - kept.length;
  return left > 0 ? [...kept, rest(left, kept.length === 0)] : kept;
}

export interface GroupWords {
  can: string;
  doing: string;
}

export type GroupBases = Partial<Record<PermissionGroup, PermissionChoice>>;

function clauseOf(choice: PermissionChoice, words: GroupWords[]): string {
  if (choice === 'allow') return `can ${joinWords(words.map((word) => word.can))} freely`;
  if (choice === 'ask') return `must ask before ${joinWords(words.map((word) => word.doing), 'or')}`;
  return `cannot ${joinWords(words.map((word) => word.can), 'or')}`;
}

export function rulesClause(bases: GroupBases, words: Record<PermissionGroup, GroupWords>): string | null {
  const clauses = PERMISSION_CHOICES.flatMap((choice) => {
    const groups = GROUP_ORDER.filter((group) => bases[group] === choice);
    return groups.length === 0 ? [] : [{ choice, text: clauseOf(choice, groups.map((group) => words[group])) }];
  });
  const [first, second, third] = clauses;
  if (first === undefined) return null;
  if (second === undefined) return first.text;
  if (third === undefined) return `${first.text}${first.choice === 'allow' ? ', but' : ' and'} ${second.text}`;
  return `${first.text}, ${second.text}, and ${third.text}`;
}

export interface RuledTool {
  label: string;
  group: PermissionGroup;
  choice: PermissionChoice;
}

const OWN_WORD: Record<PermissionChoice, string> = { allow: 'is allowed', ask: 'needs approval', block: 'is blocked' };

export const ownRules = (tools: readonly RuledTool[], bases: GroupBases): RuledTool[] => tools.filter((tool) => tool.choice !== bases[tool.group]);

export function ownRulesSentence(own: readonly RuledTool[]): string | null {
  if (own.length === 0) return null;
  const items = own.map((tool) => `${tool.label} ${OWN_WORD[tool.choice]}`);
  return `${toolRulesText(own.length)}: ${joinWords(cappedList(items, items.length, (count) => `${String(count)} more`))}`;
}

export function unanimous(choices: readonly PermissionChoice[]): PermissionChoice | null {
  const first = choices[0];
  return first !== undefined && choices.every((choice) => choice === first) ? first : null;
}

export const asksAnywhere = (bases: GroupBases, own: readonly RuledTool[]): boolean => Object.values(bases).includes('ask') || own.some((tool) => tool.choice === 'ask');
