import type { Normalized } from '@metro-labs/mcp/stations/messaging-normalize';

type Args = Record<string, unknown>;

export function normalizeLine(action: string, env: Args): Normalized {
  if (action === 'reply') {
    return {
      action: 'send',
      args: { line: env.line, text: env.text, account: env.account },
    };
  }
  return { action, args: env };
}
