import type { Station, Verb } from '@metro-labs/mcp/stations/types';

export const telegramBotStation: Station = {
  name: 'telegram-bot',
  hasAccounts: true,
  hasTrain: true,
  messageVerbs: new Set<Verb>([
    'send',
    'reply',
    'react',
    'unreact',
    'edit',
    'delete',
  ]),
  attachmentMode: 'canonical',
  tools: [],
};
