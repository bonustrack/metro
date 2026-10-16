import type { ClaudeSessionStatus } from '@metro-labs/client/api/claude-box';
import type { Selection } from '@metro-labs/client/selection';
import type { DotTone } from './tone.js';

export interface AgentHealth {
  text: string;
  dot: DotTone | null;
  fix?: Selection;
}

export function agentHealth(state: string | undefined, session: ClaudeSessionStatus | undefined, project: string): AgentHealth {
  if (state === undefined) return { text: 'Checking…', dot: null };
  if (state === 'stopped') return { text: 'Stopped. Start it again from Settings, Server.', dot: 'danger', fix: { kind: 'server', project } };
  if (state === 'updating') return { text: 'Updating. Back in about a minute.', dot: null };
  if (state !== 'live') return { text: 'Offline. The server does not answer.', dot: 'danger' };
  if (session === undefined) return { text: 'Online', dot: 'success' };
  if (session.running) return { text: 'Online and ready', dot: 'success' };
  if (session.blocked !== null) return { text: `Online, but not ready: ${session.blocked}`, dot: 'danger', fix: { kind: 'claude', project } };
  return { text: 'Online, but the agent is not running', dot: 'danger', fix: { kind: 'claude', project } };
}
