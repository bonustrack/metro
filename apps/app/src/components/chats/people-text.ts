export const PLACEHOLDER: Record<string, string> = {
  'telegram-bot': 'Telegram user id, a number',
  telegram: 'Telegram user id, a number',
  'discord-bot': 'Discord user id, a long number',
  whatsapp: 'WhatsApp id',
  threema: 'Threema ID, like ECHOECHO',
  outlook: 'Email address, or @company.com',
  gmail: 'Email address, or @company.com',
  xmtp: 'Inbox id',
};

export const WHERE_TO_FIND: Record<string, string> = {
  'telegram-bot': 'Easiest: have them write to the bot once, then pick them below.',
  telegram: 'Easiest: have them write once, then pick them below.',
  'discord-bot': 'In Discord, turn on Developer Mode, right-click the person and choose Copy User ID.',
  whatsapp: 'Easiest: look them up by phone number below.',
  threema: 'Easiest: have them write once, then pick them below.',
  outlook: '@company.com lets in everyone at that company. A subdomain needs its own entry.',
  gmail: '@company.com lets in everyone at that company. A subdomain needs its own entry.',
  xmtp: 'Their inbox id, not their wallet address. Easiest: have them write once, then pick them below.',
};

export interface LookupText {
  placeholder: string;
  hint: string;
  notFound: string;
  failed: string;
}

export const LOOKUP: Record<string, LookupText> = {
  whatsapp: {
    placeholder: 'Phone number, like +41 79 123 45 67',
    hint: 'Find someone by phone number, even if they never wrote here.',
    notFound: 'WhatsApp does not know that number, so nobody could write from it.',
    failed: 'Could not look that number up.',
  },
  xmtp: {
    placeholder: 'Wallet address or name, like 0x1234… or alice.base.eth',
    hint: 'Find someone by wallet address or name. Metro adds their inbox id.',
    notFound: 'That address has no XMTP inbox yet, so nobody could write from it.',
    failed: 'Could not look that address up.',
  },
};

export const SAVE_FAILED = 'Could not save who may write to this agent.';
