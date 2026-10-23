import { PERMISSION_CHOICES, type PermissionChoice, type PermissionGroup } from './permission-words.js';

export type Joiner = 'and' | 'or';

export interface Segment {
  text: string;
  value: boolean;
}

const LISTED_MAX = 3;
const LISTED_CUT = 2;
const GROUP_ORDER: readonly PermissionGroup[] = ['read', 'write', 'delete'];

export const val = (text: string): Segment => ({ text, value: true });

export const txt = (text: string): Segment => ({ text, value: false });

function joinWords(items: readonly string[], joiner: Joiner = 'and'): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} ${joiner} ${items[items.length - 1] ?? ''}`;
}

export const namesList = (names: string[]): string => joinWords(names);

export const toolRulesText = (count: number): string => (count === 1 ? '1 tool has its own rule' : `${String(count)} tools have their own rule`);

export const countWords = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

export function joinSegments(items: readonly (readonly Segment[])[], joiner: Joiner = 'and'): Segment[] {
  return items.flatMap((item, at) => [...(at === 0 ? [] : [txt(at === items.length - 1 ? ` ${joiner} ` : ', ')]), ...item]);
}

const joinValues = (items: readonly string[], joiner: Joiner = 'and'): Segment[] => joinSegments(items.map((item) => [val(item)]), joiner);

export function cappedList(shown: readonly string[], total: number, rest: (count: number, none: boolean) => string): string[] {
  const kept = shown.slice(0, total <= LISTED_MAX ? LISTED_MAX : LISTED_CUT);
  const left = total - kept.length;
  return left > 0 ? [...kept, rest(left, kept.length === 0)] : kept;
}

const capitalized = (text: string): string => (/^\S*@/.test(text) ? text : `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`);

function compact(segments: readonly Segment[]): Segment[] {
  return segments.reduce<Segment[]>((out, segment) => {
    const last = out[out.length - 1];
    if (segment.text === '') return out;
    if (last !== undefined && last.value === segment.value) return [...out.slice(0, -1), { text: `${last.text}${segment.text}`, value: last.value }];
    return [...out, segment];
  }, []);
}

function closed(sentence: readonly Segment[]): Segment[] {
  const [first, ...rest] = sentence;
  if (first === undefined) return [];
  const last = sentence[sentence.length - 1]?.text ?? '';
  return [{ text: capitalized(first.text), value: first.value }, ...rest, ...(/[.!?]$/.test(last) ? [] : [txt('.')])];
}

export function paragraph(sentences: readonly (readonly Segment[] | null)[]): Segment[] {
  const kept = sentences.filter((sentence): sentence is readonly Segment[] => sentence !== null && sentence.some((segment) => segment.text.trim() !== ''));
  return compact(kept.flatMap((sentence, at) => [...(at === 0 ? [] : [txt(' ')]), ...closed(sentence)]));
}

export const plainText = (segments: readonly Segment[]): string => segments.map((segment) => segment.text).join('');

export interface GroupWords {
  does: string;
  ask: string;
  cannot: string;
}

export type GroupBases = Partial<Record<PermissionGroup, PermissionChoice>>;

function clauseOf(choice: PermissionChoice, words: GroupWords[]): Segment[] {
  if (choice === 'allow') return [...joinValues(words.map((word) => word.does)), txt(' freely')];
  if (choice === 'ask') return [txt('asks before '), ...joinValues(words.map((word) => word.ask), 'or')];
  return [txt('cannot '), ...joinValues(words.map((word) => word.cannot), 'or')];
}

export function rulesClause(bases: GroupBases, words: Record<PermissionGroup, GroupWords>): Segment[] | null {
  const clauses = PERMISSION_CHOICES.flatMap((choice) => {
    const groups = GROUP_ORDER.filter((group) => bases[group] === choice);
    return groups.length === 0 ? [] : [clauseOf(choice, groups.map((group) => words[group]))];
  });
  if (clauses.length === 0) return null;
  return clauses.flatMap((clause, at) => [...(at === 0 ? [] : [txt(', ')]), ...clause]);
}

export interface RuledTool {
  label: string;
  group: PermissionGroup;
  choice: PermissionChoice;
}

const OWN_WORD: Record<PermissionChoice, string> = { allow: 'allowed', ask: 'needs approval', block: 'blocked' };

export const ownRules = (tools: readonly RuledTool[], bases: GroupBases): RuledTool[] => tools.filter((tool) => tool.choice !== bases[tool.group]);

export function ownRulesSentence(own: readonly RuledTool[]): Segment[] | null {
  if (own.length === 0) return null;
  const shown = own.slice(0, own.length <= LISTED_MAX ? LISTED_MAX : LISTED_CUT);
  const items = shown.flatMap((tool, at) => [...(at === 0 ? [] : [txt(', ')]), val(tool.label), txt(` ${OWN_WORD[tool.choice]}`)]);
  const left = own.length - shown.length;
  return [txt(own.length === 1 ? 'exception: ' : 'exceptions: '), ...items, ...(left > 0 ? [txt(' and '), val(`${String(left)} more`)] : [])];
}

export function unanimous(choices: readonly PermissionChoice[]): PermissionChoice | null {
  const first = choices[0];
  return first !== undefined && choices.every((choice) => choice === first) ? first : null;
}

export const asksAnywhere = (bases: GroupBases, own: readonly RuledTool[]): boolean => Object.values(bases).includes('ask') || own.some((tool) => tool.choice === 'ask');
