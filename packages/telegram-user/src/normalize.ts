import type { Normalized } from '@metro-labs/mcp/stations/messaging-normalize';

type Args = Record<string, unknown>;

export function normalizeTelegramUser(action: string, env: Args): Normalized {
  if (action === 'reply') {
    return {
      action: 'send',
      args: {
        line: env.line,
        text: env.text,
        replyTo: env.replyTo,
        account: env.account,
      },
    };
  }
  if (action === 'unreact') {
    return { action: 'react', args: { ...env, emoji: '' } };
  }
  return { action, args: env };
}
