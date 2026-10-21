import type { ClaudeSessionStatus } from '@metro-labs/client/api/claude-box';
import type { ChannelTrouble } from '@metro-labs/client/api/pair-again';
import type { Selection } from '@metro-labs/client/selection';

export function healthFix(state: string | undefined, session: ClaudeSessionStatus | undefined, project: string, trouble: ChannelTrouble | null = null): Selection | undefined {
  if (state === 'stopped') return { kind: 'server', project };
  if (state === 'live' && session !== undefined && !session.running) return { kind: 'claude', project };
  if (state === 'live' && trouble !== null) return { kind: 'station', project, accountId: trouble.accountId };
  return undefined;
}
