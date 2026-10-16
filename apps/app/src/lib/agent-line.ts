import type { ServerStatus } from '@metro-labs/client/api/servers';
import type { DotTone, Tone } from './tone.js';

export interface AgentLine {
  text: string;
  tone: Tone;
  dot: DotTone | null;
  busy: boolean;
}

const quiet = (text: string, busy = false): AgentLine => ({ text, tone: 'secondary', dot: null, busy });

function waitingText(waiting: number): string {
  return waiting === 1 ? 'Waiting for you: 1 approval' : `Waiting for you: ${String(waiting)} approvals`;
}

export function agentLine(status: ServerStatus | undefined, booting: string | null, waiting: number): AgentLine {
  if (status === undefined) return quiet('Checking…');
  if (booting !== null) return quiet(`Getting ready: ${booting}`, true);
  if (status.state === 'updating') return quiet('Updating', true);
  if (status.state === 'offline') return { text: 'Offline', tone: 'danger', dot: 'danger', busy: false };
  if (status.state === 'stopped') return quiet('Stopped');
  if (waiting > 0) return { text: waitingText(waiting), tone: 'default', dot: 'success', busy: false };
  return { text: 'Online', tone: 'secondary', dot: 'success', busy: false };
}

export function technicalLine(parts: (string | null | undefined)[]): string {
  return parts.filter((part): part is string => part !== null && part !== undefined && part !== '').join(' · ');
}
