import { EVERYONE } from '@metro-labs/client/api/accounts';
import { CONNECTOR_EVENTS_SINCE, type EventSubscription } from '@metro-labs/client/api/connector-events';
import type { OrgConnector } from '@metro-labs/client/api/org-connectors';
import { olderThan } from '@metro-labs/client/api/version';
import { orgConnectorStatus } from '../components/org-connector-status.js';
import { entriesOf, isDomain, type Person } from './channel-people.js';
import { cappedList, countWords, joinSegments, namesList, txt, val, type Segment } from './rule-sentence.js';
import { eventLabel } from './tool-labels.js';
import type { Tone } from './tone.js';

const SETTING_UP_MS = 3_000;
const WAITING_MS = 15_000;

type EventState = 'receiving' | 'setting_up' | 'signin' | 'failed' | 'gone';

export interface EventRow {
  name: string;
  title: string;
  description: string;
  sender: boolean;
  on: boolean;
  state: EventState | null;
  error: string | null;
}

interface StateWords {
  text: string;
  tone: Tone;
}

function stateOf(subscription: EventSubscription | undefined, signedOut: boolean): EventState {
  if (signedOut || subscription?.status === 'signed_out') return 'signin';
  if (subscription?.status === 'active') return 'receiving';
  return subscription?.status === 'error' ? 'failed' : 'setting_up';
}

export function eventRows(connector: OrgConnector, agentId: string): EventRow[] {
  const held = connector.agents.find((agent) => agent.id === agentId);
  if (connector.events === null || held === undefined) return [];
  const signedOut = orgConnectorStatus(connector).bad;
  const wanted = new Set(held.events);
  const offered = connector.events.map((event): EventRow => {
    const subscription = held.subscriptions.find((one) => one.event === event.name);
    const on = wanted.has(event.name);
    return { ...event, on, state: on ? stateOf(subscription, signedOut) : null, error: on ? (subscription?.error ?? null) : null };
  });
  const known = new Set(connector.events.map((event) => event.name));
  const gone = held.events.filter((name) => !known.has(name)).map((name): EventRow => ({ name, title: eventLabel(name), description: '', sender: false, on: true, state: 'gone', error: null }));
  return [...offered, ...gone];
}

export function stateWords(row: EventRow, connector: string): StateWords | null {
  if (row.state === null) return null;
  if (row.state === 'receiving') return { text: 'Receiving', tone: 'secondary' };
  if (row.state === 'setting_up') return { text: `Setting up: Metro is asking ${connector} to send these.`, tone: 'secondary' };
  if (row.state === 'signin') return { text: 'Waiting for sign-in: sign in to this connector again.', tone: 'danger' };
  if (row.state === 'gone') return { text: `${connector} does not offer this any more. Turn it off.`, tone: 'danger' };
  return { text: row.error ?? `Could not set this up with ${connector}.`, tone: 'danger' };
}

export function eventSubtitle(row: EventRow, technical: boolean): string | undefined {
  const parts = [row.description, technical ? row.name : ''].filter((part) => part !== '');
  return parts.length === 0 ? undefined : parts.join(' · ');
}

export function eventsPollMs(rows: readonly EventRow[]): number | null {
  if (rows.some((row) => row.state === 'setting_up')) return SETTING_UP_MS;
  return rows.some((row) => row.state === 'signin' || row.state === 'failed') ? WAITING_MS : null;
}

export function withEvent(events: readonly string[], name: string, on: boolean): string[] {
  if (!on) return events.filter((event) => event !== name);
  return events.includes(name) ? [...events] : [...events, name];
}

const anyone = (senders: string[]): boolean => senders.includes(EVERYONE);

export const sendersShown = (rows: readonly EventRow[], senders: string[]): boolean => rows.some((row) => row.on) && (rows.some((row) => row.sender) || !anyone(senders));

export const senderPeople = (senders: string[]): Person[] =>
  entriesOf(senders).map((id) => ({ id, title: id, subtitle: isDomain(id) ? `Anyone with an address at ${id.slice(1)}` : null, avatar: null, approves: null, link: null }));

const unnamedRows = (rows: readonly EventRow[], senders: string[]): EventRow[] => (anyone(senders) ? [] : rows.filter((row) => row.on && row.state !== 'gone' && !row.sender));

export function unnamedNote(rows: readonly EventRow[], senders: string[]): string | undefined {
  const unnamed = unnamedRows(rows, senders);
  if (unnamed.length === 0) return undefined;
  const titles = namesList(unnamed.map((row) => row.title));
  return unnamed.length === 1 ? `${titles} does not say who sent it, so it is dropped unless anyone can write.` : `${titles} do not say who sent them, so they are dropped unless anyone can write.`;
}

export const noServerNote = (agent: string): string => `${agent} has no server, so it cannot receive events, but it can still use the tools.`;

export const waitsForUpdate = (version: string | null, remote: boolean): boolean => !remote && olderThan(version, CONNECTOR_EVENTS_SINCE);

export const updateNote = (agent: string): string =>
  `Events wait on Metro's side, 7 days at most, until ${agent}'s Metro is updated to ${CONNECTOR_EVENTS_SINCE} or later: open ${agent}'s Settings, then Metro version under Server.`;

const moreWords = (count: number): string => `${String(count)} more`;

const restWords = (count: number, none: boolean): string => (none ? countWords(count, 'person', 'people') : countWords(count, 'other', 'others'));

const titlesOf = (rows: readonly EventRow[]): Segment[] => joinSegments(cappedList(rows.map((row) => row.title), rows.length, moreWords).map((title) => [val(title)]));

function fromWords(senders: string[]): Segment[] {
  if (anyone(senders)) return [val('anyone')];
  const entries = entriesOf(senders);
  if (entries.length === 0) return [val('nobody')];
  const domains = entries.filter(isDomain).map((domain) => [txt('anyone at '), val(domain)]);
  const people = entries.filter((entry) => !isDomain(entry));
  return joinSegments([...domains, ...cappedList(people, people.length, restWords).map((name) => [val(name)])]);
}

const sentence = (rows: readonly EventRow[], one: Segment[], many: Segment[]): Segment[] | null => (rows.length === 0 ? null : [...titlesOf(rows), ...(rows.length === 1 ? one : many)]);

export function eventSentences(agent: string, rows: readonly EventRow[], senders: string[]): (Segment[] | null)[] {
  const unnamed = unnamedRows(rows, senders);
  const heard = rows.filter((row) => row.on && !unnamed.includes(row));
  const reaching = heard.filter((row) => row.state === 'receiving' || row.state === 'setting_up');
  const waiting = heard.filter((row) => row.state === 'signin');
  const missing = heard.filter((row) => row.state === 'failed' || row.state === 'gone');
  const from = [val(agent), txt(' from '), ...fromWords(senders)];
  return [
    sentence(reaching, [txt(' reaches '), ...from], [txt(' reach '), ...from]),
    sentence(waiting, [txt(' waits for a '), val('new sign-in')], [txt(' wait for a '), val('new sign-in')]),
    sentence(missing, [txt(' is '), val('not arriving')], [txt(' are '), val('not arriving')]),
    sentence(unnamed, [txt(' is '), val('dropped'), txt(', since it names no sender')], [txt(' are '), val('dropped'), txt(', since they name no sender')]),
  ];
}
