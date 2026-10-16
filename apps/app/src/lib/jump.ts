export type JumpGroup = 'agents' | 'pages' | 'actions';

export const JUMP_GROUPS: readonly JumpGroup[] = ['agents', 'pages', 'actions'];

export const JUMP_GROUP_LABEL: Record<JumpGroup, string> = { agents: 'Agents', pages: 'Pages', actions: 'Actions' };

const LIMITS: Record<JumpGroup, number> = { agents: 6, pages: 6, actions: 5 };

export interface JumpEntry<T> {
  key: string;
  group: JumpGroup;
  crumbs: string[];
  words?: string[];
  idle?: boolean;
  payload: T;
}

const EXACT = 4;
const PREFIX = 3;
const INSIDE = 1;
const LEAD = 1;

const wordsOf = (text: string): string[] => text.toLowerCase().split(/[^\p{L}\p{N}.]+/u).filter((word) => word !== '');

export const tokensOf = (query: string): string[] => wordsOf(query);

function tokenScore(token: string, words: string[]): number {
  let best = 0;
  for (const word of words) {
    const score = word === token ? EXACT : word.startsWith(token) ? PREFIX : word.includes(token) ? INSIDE : 0;
    if (score > best) best = score;
  }
  return best;
}

export function jumpScore<T>(entry: JumpEntry<T>, tokens: string[]): number | null {
  const words = [...entry.crumbs.flatMap(wordsOf), ...(entry.words ?? []).flatMap(wordsOf)];
  const lead = wordsOf(entry.crumbs[0] ?? '');
  let total = 0;
  for (const token of tokens) {
    const score = tokenScore(token, words);
    if (score === 0) return null;
    total += score + (tokenScore(token, lead) > 0 ? LEAD : 0);
  }
  return total;
}

interface Scored<T> {
  entry: JumpEntry<T>;
  score: number;
  at: number;
}

function byRank<T>(a: Scored<T>, b: Scored<T>): number {
  return b.score - a.score || a.entry.crumbs.length - b.entry.crumbs.length || a.at - b.at;
}

export function rankJump<T>(entries: JumpEntry<T>[], query: string, limits: Record<JumpGroup, number> = LIMITS): JumpEntry<T>[] {
  const tokens = tokensOf(query);
  const scored = entries.flatMap((entry, at): Scored<T>[] => {
    if (tokens.length === 0) return entry.idle === true ? [{ entry, score: 0, at }] : [];
    const score = jumpScore(entry, tokens);
    return score === null ? [] : [{ entry, score, at }];
  });
  return JUMP_GROUPS.flatMap((group) => scored.filter((s) => s.entry.group === group).sort(byRank).slice(0, limits[group]).map((s) => s.entry));
}

export function groupJump<T>(ranked: JumpEntry<T>[]): { group: JumpGroup; entries: JumpEntry<T>[] }[] {
  return JUMP_GROUPS.flatMap((group) => {
    const entries = ranked.filter((entry) => entry.group === group);
    return entries.length === 0 ? [] : [{ group, entries }];
  });
}

export function moveCursor(cursor: number, by: number, count: number): number {
  if (count === 0) return 0;
  return (((cursor + by) % count) + count) % count;
}

export function isJumpKey(key: string, meta: boolean, ctrl: boolean): boolean {
  return key.toLowerCase() === 'k' && (meta || ctrl);
}
