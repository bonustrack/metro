import { EVERYONE } from '@metro-labs/client/api/accounts';
import { isDomain, type Person } from './channel-people.js';
import { cappedList, countWords, joinSegments, txt, val, type Segment } from './rule-sentence.js';

interface MailSetup {
  senders: string[];
  receive: boolean;
}

type EntryChange = { next: string[] } | { error: string };

const ADDRESS_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DOMAIN_RE = /^@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

const MAIL_ENTRY_ERROR = 'Enter an email address, or @company.com for everyone at a company.';
const MAIL_DUPLICATE = 'This address is already in the list.';

export const mailEntries = (senders: readonly string[]): string[] => senders.filter((entry) => entry !== EVERYONE);

export const anyoneWrites = (senders: readonly string[]): boolean => senders.length === 0 || senders.includes(EVERYONE);

export function withMailEntry(entries: readonly string[], raw: string): EntryChange {
  const entry = raw.trim().toLowerCase();
  if (!ADDRESS_RE.test(entry) && !DOMAIN_RE.test(entry)) return { error: MAIL_ENTRY_ERROR };
  if (entries.includes(entry)) return { error: MAIL_DUPLICATE };
  return { next: [...entries, entry] };
}

export const withoutMailEntry = (entries: readonly string[], id: string): string[] => entries.filter((entry) => entry !== id);

export const nextSenders = (entries: readonly string[]): string[] => (entries.length === 0 ? [EVERYONE] : [...entries]);

export function mailPeople(entries: readonly string[]): Person[] {
  return entries.map((id) => ({
    id,
    title: id,
    subtitle: isDomain(id) ? `Anyone with an address at ${id.slice(1)}` : null,
    avatar: null,
    approves: null,
    link: isDomain(id) ? null : `mailto:${id}`,
  }));
}

const restWords = (count: number, none: boolean): string => (none ? countWords(count, 'address', 'addresses') : countWords(count, 'other', 'others'));

export function mailLine(agent: string, setup: MailSetup): Segment[] {
  if (!setup.receive) return [val(agent), txt(' gets '), val('no new mail')];
  if (anyoneWrites(setup.senders)) return [val('anyone'), txt(' can write')];
  const entries = mailEntries(setup.senders);
  const shown = cappedList(entries, entries.length, restWords).map((entry) => [val(entry)]);
  return [...joinSegments(shown), txt(' can write')];
}
