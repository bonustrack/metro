import { CONNECTOR_EVENTS_SINCE } from '@metro-labs/client/api/connector-events';
import { MOVE_OVERLAP_MS, receivesMail, type MailStation, type MoveProgress, type MoveStep } from '@metro-labs/client/api/mail-move';
import { rulesCarried, sendersCarried, type CarriedCheck, type MovePlan, type RuleMove, type SendersMove } from '@metro-labs/client/api/mail-move-plan';
import type { GroupedTool } from '@metro-labs/client/api/policy';
import { CHOICE_WORD, choiceOfAccess } from './permission-words.js';
import { cappedList, namesList } from './rule-sentence.js';
import { toolLabel } from './tool-labels.js';
import type { Tone } from './tone.js';

const DEFAULT_SERVERS: Record<MailStation, string> = { gmail: 'https://mcp.gmail.piston.box/', outlook: 'https://mcp.outlook.piston.box/' };
const OVERRIDES: Record<MailStation, unknown> = { gmail: process.env.EXPO_PUBLIC_METRO_GMAIL_MCP_URL, outlook: process.env.EXPO_PUBLIC_METRO_OUTLOOK_MCP_URL };
const COMPANY: Record<MailStation, string> = { gmail: 'Google', outlook: 'Microsoft' };
const SETTING_UP_MS = 3_000;
const WAITING_MS = 15_000;

export const MOVE_TITLE = 'Move to a connector';

export function mailServerOf(station: MailStation, override: unknown = OVERRIDES[station]): string {
  const configured = typeof override === 'string' ? override.trim() : '';
  return configured === '' ? DEFAULT_SERVERS[station] : configured;
}

export const mailCompany = (station: MailStation): string => COMPANY[station];

export const MOVE_STEPS = [
  { id: 'connector', label: 'Sign in' },
  { id: 'review', label: 'Review' },
  { id: 'switch', label: 'Switch' },
  { id: 'done', label: 'Done' },
] as const;

export const stepperOf = (step: MoveStep): string => (step.step === 'starting' || step.step === 'overlap' ? 'switch' : step.step);

export function movePollMs(step: MoveStep, signingIn: boolean): number | null {
  if (step.step === 'connector') return signingIn ? SETTING_UP_MS : null;
  if (step.step === 'starting') return step.state === 'setting_up' ? SETTING_UP_MS : WAITING_MS;
  if (step.step === 'overlap') return SETTING_UP_MS;
  return step.step === 'done' && step.mail === 'waiting' ? WAITING_MS : null;
}

export const overlapSeconds = (since: number, now: number): number => Math.max(0, Math.ceil((since + MOVE_OVERLAP_MS - now) / 1_000));

export interface EntryInput {
  agent: string;
  admin: boolean;
  known: boolean | null;
  tooOld: boolean;
  progress: MoveProgress;
}

export interface MoveEntry {
  text: string;
  tone: Tone;
  opens: 'move' | 'server' | null;
}

export const entryTitle = (label: string): string => `${label} channels are moving to connectors`;

export const updateFirst = (agent: string): string => `Update first: ${agent}'s Metro must be ${CONNECTOR_EVENTS_SINCE} or later to receive mail from a connector.`;

export const NOT_OPEN = "Not open yet: Metro's servers cannot deliver mail from a connector.";

const twiceText = (agent: string): string => `Mail from this mailbox reaches ${agent} twice right now.`;

function adminEntry(agent: string, progress: MoveProgress): MoveEntry {
  if (progress === 'twice') return { text: `${twiceText(agent)} Finish the move.`, tone: 'danger', opens: 'move' };
  if (progress === 'moved') return { text: 'Mail now arrives through a connector. This channel can be removed.', tone: 'secondary', opens: 'move' };
  if (progress === 'started') return { text: 'The move has started. Continue it.', tone: 'secondary', opens: 'move' };
  return { text: 'Mail will arrive through a connector of the organization. A few guided steps carry the settings over.', tone: 'secondary', opens: 'move' };
}

export function moveEntry(input: EntryInput): MoveEntry {
  if (input.known === false) return { text: NOT_OPEN, tone: 'secondary', opens: null };
  if (!input.admin && input.progress === 'twice') return { text: `${twiceText(input.agent)} Ask an admin of the organization to finish the move.`, tone: 'danger', opens: null };
  if (!input.admin) return { text: 'Only an admin of the organization can move it.', tone: 'secondary', opens: null };
  if (input.tooOld) return { text: updateFirst(input.agent), tone: 'secondary', opens: 'server' };
  return adminEntry(input.agent, input.progress);
}

const moreWords = (count: number): string => `${String(count)} more`;

const shortList = (entries: readonly string[]): string => namesList(cappedList(entries, entries.length, moreWords));

export interface SummaryLine {
  title: string;
  value?: string;
  text: string;
  tone?: Tone;
}

function droppedText(dropped: readonly string[]): string {
  const subject = dropped.length === 1 ? 'is not an email address or a domain, so it never matched a sender and is' : 'are not email addresses or domains, so they never matched a sender and are';
  return `${shortList(dropped)} ${subject} left out.`;
}

export function sendersLines(senders: SendersMove): SummaryLine[] {
  if (senders.nobody)
    return [{
      title: 'Nobody could write',
      text: `No entry of the channel's list is an email address or a domain (${shortList(senders.dropped)}). Metro cannot store a list with nobody on it, so Who can write is not changed on the connector. Add people on the connector's page before you turn Email received on.`,
      tone: 'danger',
    }];
  const anyone = senders.senders.includes('*');
  const carried: SummaryLine = anyone ? { title: 'Anyone', text: 'Anyone can write, as on the channel.' } : { title: shortList(senders.senders), text: 'The same people as on the channel.' };
  return senders.dropped.length === 0 ? [carried] : [carried, { title: 'Left out', text: droppedText(senders.dropped) }];
}

export function receiveLine(plan: MovePlan, receiving: boolean, agent: string): SummaryLine {
  if (plan.receive) return { title: 'Email received', value: 'On', text: `New mail reaches ${agent} through the connector, as it did through the channel.` };
  if (!receiving) return { title: 'Email received', value: 'Off', text: "Receive messages is off on the channel, so it stays off. Turn it on later on the connector's page." };
  return { title: 'Email received', value: 'Off', text: 'Nobody could write, so no mail reached the agent. It stays off.' };
}

const before = (rule: RuleMove): string => CHOICE_WORD[choiceOfAccess(rule.before)];

function ruleText(rule: RuleMove, agent: string): string {
  if (rule.reason === 'same') return 'As on the channel.';
  const stricter = `Stricter than the channel's ${before(rule)}:`;
  if (rule.reason === 'folded') {
    const jobs = namesList(rule.folded.map(toolLabel));
    return `${stricter} ${jobs} ${rule.folded.length === 1 ? 'was' : 'were'} stricter there, and ${rule.title} does that job on the connector.`;
  }
  if (rule.reason === 'assignment') return `${stricter} ${agent} already has this rule for the connector, and it is kept.`;
  return `${stricter} the organization's rule for this connector applies, and an agent's rule can only be stricter.`;
}

export const ruleLines = (rules: readonly RuleMove[], agent: string): SummaryLine[] =>
  rules.map((rule) => ({ title: rule.title, value: CHOICE_WORD[choiceOfAccess(rule.after)], text: ruleText(rule, agent) }));

export function notCarried(station: MailStation, readOnlyAtGoogle: boolean): SummaryLine[] {
  const marks = station === 'outlook' ? 'Reading one mail in full still marks it as read in Outlook, as before.' : 'Reading still never marks mail as read in Gmail, as before.';
  const lines: SummaryLine[] = [
    { title: 'Can approve', text: 'Email never answered approval questions, and connector mail does not either. Questions keep going to chat and to metro.box.' },
    { title: 'Automated mail', text: 'The connector always skips automated mail: no-reply senders, newsletters and bulk mail. A channel that was set to keep it stops getting it.' },
    { title: 'Marking mail as read', text: `This is not a setting. ${marks}` },
    { title: 'Past conversations', text: "They stay on the old channel's page until the channel is removed. The mailbox keeps every mail, and the agent reads it with the connector." },
  ];
  if (!readOnlyAtGoogle) return lines;
  return [...lines, { title: 'Read-only at Google', text: 'The connector asks Google for reading and sending. The agent still sends only when the Write rule above lets it.' }];
}

export type ActionId = 'assign' | 'rules' | 'senders' | 'event' | 'channel';

export interface MoveAction {
  id: ActionId;
  title: string;
  text?: string;
  done: boolean;
}

export interface ActionsInput {
  plan: MovePlan;
  held: (CarriedCheck & { events: string[] }) | undefined;
  receiving: boolean;
  connector: string;
  agent: string;
  tools: readonly GroupedTool[];
}

function channelAction(plan: MovePlan, receiving: boolean): MoveAction {
  const title = 'Switch Receive messages off on the old channel';
  if (!receiving) return { id: 'channel', title, done: true };
  const text = plan.receive ? 'Once mail arrives through the connector, and one minute later, so that no mail is missed.' : 'At once: nobody could write, so no mail is missed.';
  return { id: 'channel', title, text, done: false };
}

export function moveActions(input: ActionsInput): MoveAction[] {
  const { plan, held, connector, agent } = input;
  const actions: MoveAction[] = [
    { id: 'assign', title: `Give ${connector} to ${agent}`, done: held !== undefined },
    { id: 'rules', title: `Set ${agent}'s rules for ${connector}`, done: held !== undefined && rulesCarried(plan, held, input.tools) },
  ];
  if (!plan.senders.nobody) actions.push({ id: 'senders', title: 'Set who can write', done: held !== undefined && sendersCarried(plan, held) });
  if (plan.receive || receivesMail(held)) actions.push({ id: 'event', title: 'Turn Email received on', done: receivesMail(held) });
  return [...actions, channelAction(plan, input.receiving)];
}

export const pendingNow = (actions: readonly MoveAction[], plan: MovePlan): MoveAction[] => actions.filter((action) => !action.done && (action.id !== 'channel' || !plan.receive));

const ACTION_FAILED: Record<ActionId, string> = {
  assign: 'Could not give the connector to the agent',
  rules: 'Could not set the rules',
  senders: 'Could not set who can write',
  event: 'Could not turn Email received on',
  channel: 'Could not switch Receive messages off on the old channel',
};

export function failureText(failed: ActionId, reason: string, done: number): string {
  const kept = done === 0 ? 'Nothing was changed.' : done === 1 ? 'The step before it is done and stays in place.' : 'The steps before it are done and stay in place.';
  return `${ACTION_FAILED[failed]}: ${reason} ${kept} Press the button again to go on from there.`;
}

export interface StatusWords {
  title: string;
  text: string;
  tone: Tone;
}

interface StatusNames {
  agent: string;
  mailbox: string;
}

function startingWords(step: Extract<MoveStep, { step: 'starting' }>): StatusWords {
  const safe = 'The old channel keeps receiving, so no mail is missed.';
  if (step.state === 'signin') return { title: 'Waiting for sign-in', text: `The connector is signed out, so it cannot send mail yet. ${safe}`, tone: 'danger' };
  if (step.state === 'failed') return { title: 'Not receiving yet', text: `${step.error ?? 'Could not set this up with the connector.'} Metro keeps trying. ${safe}`, tone: 'danger' };
  return { title: 'Setting up', text: `Metro is asking the connector to send new mail. This takes up to a minute. ${safe}`, tone: 'secondary' };
}

function doneWords(mail: 'connector' | 'waiting' | 'none', names: StatusNames): StatusWords {
  if (mail === 'connector') return { title: 'Receiving', text: `${names.agent} receives mail from ${names.mailbox} through the connector. The old channel is switched off.`, tone: 'success' };
  if (mail === 'waiting')
    return { title: 'Mail is not arriving', text: `The old channel is switched off and the connector is not sending yet, so mail from ${names.mailbox} does not reach ${names.agent} right now.`, tone: 'danger' };
  return { title: 'Mail is not arriving', text: `Receive messages is off on the old channel and Email received is off on the connector, so mail from ${names.mailbox} does not reach ${names.agent}.`, tone: 'secondary' };
}

export function statusWords(step: MoveStep, names: StatusNames): StatusWords | null {
  if (step.step === 'starting') return startingWords(step);
  if (step.step === 'overlap') return { title: 'Receiving on both', text: `Mail arrives through the connector. The old channel still receives too, so a mail that arrives now reaches ${names.agent} twice.`, tone: 'secondary' };
  return step.step === 'done' ? doneWords(step.mail, names) : null;
}

export function overlapNote(seconds: number, automatic: boolean): string {
  if (seconds > 0) return `The old channel gets ${String(seconds)} more ${seconds === 1 ? 'second' : 'seconds'} to deliver what arrived before the connector started.`;
  return automatic ? 'Switching the old channel off.' : 'The old channel has delivered what arrived before. Switch it off now.';
}

export function removeLines(managedGmail: boolean, arriving: boolean): string[] {
  const first = arriving ? 'This deletes the old channel and its saved sign-in. Mail keeps arriving through the connector.' : 'This deletes the old channel and its saved sign-in.';
  const google = 'Google revokes the access the old channel had, so other boxes that use the same Google sign-in through Metro must sign in again. If Google cannot revoke it, the channel is kept so you can try again.';
  return [first, ...(managedGmail ? [google] : []), 'This cannot be undone.'];
}
