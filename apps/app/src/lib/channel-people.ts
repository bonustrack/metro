import { allowsEveryone, EVERYONE } from '@metro-labs/client/api/accounts';
import { type RecentSender } from '@metro-labs/client/api/attach';
import { chatLink, type SenderCard } from '@metro-labs/client/api/senders';

const NO_CHAT_APPROVALS = new Set(['outlook', 'gmail']);

export const approvesInChat = (station: string): boolean => !NO_CHAT_APPROVALS.has(station);

const sameId = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export const listed = (list: readonly string[], id: string): boolean => list.some((entry) => sameId(entry, id));

export const entriesOf = (allowlist: string[] | null): string[] => (allowlist ?? []).filter((entry) => entry !== EVERYONE);

export type Writers = 'anyone' | 'some';

export const writersOf = (allowlist: string[] | null): Writers => (allowsEveryone(allowlist) ? 'anyone' : 'some');

export function withPerson(entries: string[], raw: string): string[] | null {
  const id = raw.trim();
  if (id === '' || listed(entries, id)) return null;
  return [...entries, id];
}

export const withoutPerson = (entries: string[], id: string): string[] => entries.filter((entry) => entry !== id);

export const keptApprovers = (entries: string[], approvers: string[]): string[] => approvers.filter((approver) => listed(entries, approver));

export const withApprover = (approvers: string[], id: string, approves: boolean): string[] =>
  approves ? (listed(approvers, id) ? approvers : [...approvers, id]) : approvers.filter((approver) => !sameId(approver, id));

export const isDomain = (entry: string): boolean => entry.startsWith('@') && entry.includes('.');

export interface Person {
  id: string;
  title: string;
  subtitle: string | null;
  avatar: string | null;
  approves: boolean | null;
  link: string | null;
}

interface PeopleInput {
  station: string;
  entries: string[];
  approvers: string[];
  cards: SenderCard[];
  seen: RecentSender[];
  technical: boolean;
}

function subtitleOf(id: string, title: string, handle: string, technical: boolean): string | null {
  if (isDomain(id)) return `Anyone with an address at ${id.slice(1)}`;
  const parts = [handle, technical ? id : ''].filter((part) => part !== '' && part !== title);
  return parts.length === 0 ? null : parts.join(' · ');
}

const firstFilled = (...values: string[]): string => values.find((value) => value !== '') ?? '';

const approvesOf = (station: string, approvers: string[], id: string): boolean | null => (approvesInChat(station) ? listed(approvers, id) : null);

const linkOf = (station: string, id: string, handle: string): string | null => chatLink(station, id, handle === '' ? undefined : handle);

function personOf({ station, approvers, cards, seen, technical }: PeopleInput, id: string): Person {
  const card: SenderCard = cards.find((c) => sameId(c.id, id)) ?? { id };
  const handle = card.handle ?? '';
  const seenName = seen.find((s) => sameId(s.id, id))?.name ?? '';
  const title = firstFilled(card.name ?? '', seenName, handle, id);
  return { id, title, subtitle: subtitleOf(id, title, handle, technical), avatar: card.avatar ?? null, approves: approvesOf(station, approvers, id), link: linkOf(station, id, handle) };
}

export const peopleOf = (input: PeopleInput): Person[] => input.entries.map((id) => personOf(input, id));

export const suggestionsOf = (seen: RecentSender[], entries: string[]): RecentSender[] => seen.filter((sender) => !listed(entries, sender.id));

const count = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

export function writersSummary(allowlist: string[] | null): string | null {
  if (allowlist === null) return null;
  if (allowsEveryone(allowlist)) return 'Anyone';
  const entries = entriesOf(allowlist);
  const domains = entries.filter(isDomain);
  const people = entries.length - domains.length;
  const parts = [people === 0 ? '' : count(people, 'person', 'people'), domains.length === 1 ? (domains[0] ?? '') : domains.length > 1 ? count(domains.length, 'domain', 'domains') : ''];
  return parts.filter((part) => part !== '').join(', ');
}

export function peopleHeading(entries: string[]): string {
  if (entries.length === 0 || entries.some(isDomain)) return 'People';
  return count(entries.length, 'person', 'people');
}

export function namesList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
}

export const approverNames = (people: Person[]): string[] => people.filter((person) => person.approves === true).map((person) => person.title);

export interface QuestionsGoTo {
  title: string;
  subtitle: string;
}

const possessive = (name: string): string => `${name}'s`;

export function questionsGoTo(approvers: string[], handle: string): QuestionsGoTo {
  const first = approvers[0];
  if (first === undefined) return { title: 'Only on Home', subtitle: 'Turn on Can approve for someone to get them in a private chat.' };
  const title = approvers.length === 1 ? `${possessive(first)} private chat` : approvers.length === 2 ? `${possessive(first)} or ${possessive(approvers[1] ?? '')} private chat` : 'A private chat with someone who can approve';
  const where = handle === '' ? '' : `With ${handle}. `;
  return { title, subtitle: `${where}${approvers.length > 1 ? 'Whoever wrote last. ' : ''}They also show on Home.` };
}
