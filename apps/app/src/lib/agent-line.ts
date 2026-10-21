import type { ClaudeSessionStatus } from '@metro-labs/client/api/claude-box';
import { troubleLine, type ChannelTrouble } from '@metro-labs/client/api/pair-again';
import type { ServerStatus } from '@metro-labs/client/api/servers';
import { rightNow, workingLine } from './right-now.js';
import type { Setup } from './setup-steps.js';
import type { DotTone, Tone } from './tone.js';

export interface AgentLine {
  text: string;
  tone: Tone;
  dot: DotTone | null;
  busy: boolean;
  needsYou: boolean;
}

export interface LineFacts {
  status: ServerStatus | undefined;
  booting: string | null;
  waiting: number;
  ask: string | null;
  setup: Setup | null;
  trouble: ChannelTrouble | null;
  session: ClaudeSessionStatus | undefined;
  now: number;
}

const quiet = (text: string, busy = false): AgentLine => ({ text, tone: 'secondary', dot: null, busy, needsYou: false });

const online = (text: string): AgentLine => ({ text, tone: 'secondary', dot: 'success', busy: false, needsYou: false });

export const shortVersion = (version: string): string => version.replace(/^\d+\.\d+\.\d+-/, '');

const BOOT_WORDS: Record<string, string> = {
  starting: 'starting the server',
  pending: 'starting the server',
  running: 'installing Metro',
};

function bootText(state: string): string {
  const words = BOOT_WORDS[state];
  return words === undefined ? 'Getting ready' : `Getting ready: ${words}`;
}

function waitingText(waiting: number, ask: string | null): string {
  if (ask !== null) return `Waiting for you: ${ask}`;
  return waiting === 1 ? 'Waiting for you: 1 approval' : `Waiting for you: ${String(waiting)} approvals`;
}

function liveLine(facts: LineFacts): AgentLine {
  const { session, setup } = facts;
  if (facts.waiting > 0) return { text: waitingText(facts.waiting, facts.ask), tone: 'default', dot: 'success', busy: false, needsYou: true };
  if (session !== undefined && !session.running) return { text: 'Not running', tone: 'danger', dot: 'danger', busy: false, needsYou: true };
  if (facts.trouble !== null) return { text: troubleLine(facts.trouble), tone: 'danger', dot: 'danger', busy: false, needsYou: true };
  if (setup !== null && setup.open !== null)
    return { text: `Setting up: ${String(setup.done)} of ${String(setup.steps.length)}`, tone: 'default', dot: null, busy: false, needsYou: true };
  const working = session === undefined ? null : workingLine(rightNow(session, facts.now));
  return online(working ?? 'Online');
}

export function agentLine(facts: LineFacts): AgentLine {
  const { status } = facts;
  if (status === undefined) return quiet('Checking…');
  if (facts.booting !== null) return quiet(bootText(facts.booting), true);
  if (status.state === 'updating') return quiet(status.updatingTo === undefined ? 'Updating' : `Updating to ${shortVersion(status.updatingTo)}`, true);
  if (status.state === 'offline') return { text: 'Offline', tone: 'danger', dot: 'danger', busy: false, needsYou: true };
  if (status.state === 'stopped') return quiet('Stopped');
  return liveLine(facts);
}

export function orderAgents<T extends { name: string; line: AgentLine }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => Number(b.line.needsYou) - Number(a.line.needsYou) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

export function technicalLine(parts: (string | null | undefined)[]): string {
  return parts.filter((part): part is string => part !== null && part !== undefined && part !== '').join(' · ');
}
