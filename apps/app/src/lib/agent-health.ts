import type { ClaudeSessionStatus } from '@metro-labs/client/api/claude-box';
import type { Selection } from '@metro-labs/client/selection';

export function healthFix(state: string | undefined, session: ClaudeSessionStatus | undefined, project: string): Selection | undefined {
  if (state === 'stopped') return { kind: 'server', project };
  if (state === 'live' && session !== undefined && !session.running) return { kind: 'claude', project };
  return undefined;
}
