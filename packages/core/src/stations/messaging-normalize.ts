type Args = Record<string, unknown>;

export interface Normalized {
  action: string;
  args: Args;
}

export type Normalize = (action: string, args: Args) => Normalized;

export const messagingAliases =
  (removal: Args = { emoji: '' }): Normalize =>
  (action, args) => {
    if (action === 'reply') return { action: 'send', args };
    if (action === 'unreact') return { action: 'react', args: { ...args, ...removal } };
    return { action, args };
  };
