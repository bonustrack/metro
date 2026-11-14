import type { AccountRow } from './accounts.js';
import type { ConnectorListing } from './connectors.js';
import type { OrgConnector } from './org-connectors.js';

export type MailStation = 'gmail' | 'outlook';

export const MAIL_STATIONS: readonly MailStation[] = ['gmail', 'outlook'];
export const MAIL_EVENT = 'email.received';
export const MOVE_OVERLAP_MS = 60_000;

const NAME_MAX = 64;
const ADDRESS = '[a-z0-9._%+-]+@[a-z0-9-]+(?:\\.[a-z0-9-]+)+';
const MAILBOX_RE = /^[^@\s/]+@[^@\s/]+$/;

export const isMailStation = (station: string): station is MailStation => MAIL_STATIONS.some((known) => known === station);

export const isMailbox = (value: string): boolean => MAILBOX_RE.test(value);

const fieldOf = (row: AccountRow, label: string): string => row.fields.find((field) => field.label === label)?.value ?? '';

export const channelMailbox = (row: AccountRow): string | null => ['email', 'handle'].map((label) => fieldOf(row, label).trim().toLowerCase()).find(isMailbox) ?? null;

export function signedInMailbox(listing: Pick<ConnectorListing, 'account' | 'instructions'>): string | null {
  const declared = (listing.account ?? '').trim().toLowerCase();
  if (isMailbox(declared)) return declared;
  const named = new Set(Array.from((listing.instructions ?? '').toLowerCase().matchAll(new RegExp(ADDRESS, 'g')), (found) => found[0]));
  const [only] = named;
  return named.size === 1 && only !== undefined ? only : null;
}

export type ListingState = 'loading' | 'failed' | { mailbox: string | null };

export interface Candidate {
  connector: OrgConnector;
  listing: ListingState;
}

export type MailboxCheck = { kind: 'match' | 'signed-out' | 'checking' | 'unknown' | 'unreadable' } | { kind: 'other'; address: string };

export interface Target {
  connector: OrgConnector;
  check: MailboxCheck;
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

const older = (left: OrgConnector, right: OrgConnector): number => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);

export const mailConnectors = (connectors: readonly OrgConnector[], server: string): OrgConnector[] =>
  connectors.filter((connector) => sameOrigin(connector.url, server)).sort(older);

export const connectorNameFor = (mailbox: string): string => mailbox.slice(0, NAME_MAX);

const namedAfter = (connector: OrgConnector, mailbox: string): boolean => connector.name.trim().toLowerCase() === connectorNameFor(mailbox);

function checkOf(candidate: Candidate, mailbox: string): MailboxCheck {
  if (candidate.connector.signIn !== 'connected') return { kind: 'signed-out' };
  const { listing } = candidate;
  if (listing === 'loading') return { kind: 'checking' };
  if (listing === 'failed') return { kind: 'unreadable' };
  if (listing.mailbox === null) return { kind: 'unknown' };
  return listing.mailbox === mailbox ? { kind: 'match' } : { kind: 'other', address: listing.mailbox };
}

export function pickTarget(mailbox: string, candidates: readonly Candidate[]): Target | 'checking' | null {
  const checked = candidates.map((candidate): Target => ({ connector: candidate.connector, check: checkOf(candidate, mailbox) }));
  const matched = checked.find((target) => target.check.kind === 'match');
  if (matched !== undefined) return matched;
  if (checked.some((target) => target.check.kind === 'checking')) return 'checking';
  return checked.find((target) => namedAfter(target.connector, mailbox)) ?? null;
}

export function eventsKnown(connectors: readonly OrgConnector[]): boolean | null {
  if (connectors.length === 0) return null;
  return connectors.every((connector) => connector.events !== null);
}

type Held = OrgConnector['agents'][number];

export type MoveStep =
  | { step: 'connector'; need: 'create' | 'sign-in' | 'checking' | 'confirm' | 'unreadable' }
  | { step: 'connector'; need: 'wrong-mailbox'; address: string }
  | { step: 'review' }
  | { step: 'starting'; state: 'setting_up' | 'signin' | 'failed'; error: string | null }
  | { step: 'overlap' }
  | { step: 'done'; mail: 'connector' | 'waiting' | 'none' };

export interface MoveFacts {
  receiving: boolean;
  target: Target | 'checking' | null;
  agentId: string;
  confirmed: boolean;
  carried: boolean;
}

export const heldBy = (connector: OrgConnector, agentId: string): Held | undefined => connector.agents.find((agent) => agent.id === agentId);

const subscriptionOf = (held: Held): Held['subscriptions'][number] | undefined => held.subscriptions.find((one) => one.event === MAIL_EVENT);

export const receivesMail = (held: Pick<Held, 'events'> | undefined): boolean => held?.events.includes(MAIL_EVENT) === true;

function connectorNeed(check: MailboxCheck, trusted: boolean): MoveStep | null {
  if (check.kind === 'match') return null;
  if (check.kind === 'other') return { step: 'connector', need: 'wrong-mailbox', address: check.address };
  if (check.kind === 'signed-out') return { step: 'connector', need: 'sign-in' };
  if (check.kind === 'checking') return { step: 'connector', need: 'checking' };
  if (trusted) return null;
  return { step: 'connector', need: check.kind === 'unknown' ? 'confirm' : 'unreadable' };
}

function mailOf(held: Held): 'connector' | 'waiting' | 'none' {
  if (!receivesMail(held)) return 'none';
  return subscriptionOf(held)?.status === 'active' ? 'connector' : 'waiting';
}

function switching(held: Held): MoveStep {
  const subscription = subscriptionOf(held);
  if (subscription?.status === 'active') return { step: 'overlap' };
  const state = subscription?.status === 'signed_out' ? 'signin' : subscription?.status === 'error' ? 'failed' : 'setting_up';
  return { step: 'starting', state, error: subscription?.error ?? null };
}

export function moveStep(facts: MoveFacts): MoveStep {
  const { target } = facts;
  if (target === 'checking') return { step: 'connector', need: 'checking' };
  if (target === null) return { step: 'connector', need: 'create' };
  const held = heldBy(target.connector, facts.agentId);
  const blocked = connectorNeed(target.check, facts.confirmed || held !== undefined);
  if (blocked !== null) return blocked;
  if (held === undefined) return { step: 'review' };
  if (!receivesMail(held) && (facts.receiving || !facts.carried)) return { step: 'review' };
  return facts.receiving ? switching(held) : { step: 'done', mail: mailOf(held) };
}

export type MoveProgress = 'none' | 'started' | 'twice' | 'moved';

export function moveProgress(mailbox: string, candidates: readonly OrgConnector[], agentId: string, receiving: boolean): MoveProgress {
  const held = candidates.filter((connector) => namedAfter(connector, mailbox)).map((connector) => heldBy(connector, agentId)).find((one) => one !== undefined);
  if (held === undefined) return 'none';
  if (!receivesMail(held)) return 'started';
  if (!receiving) return 'moved';
  return subscriptionOf(held)?.status === 'active' ? 'twice' : 'started';
}
