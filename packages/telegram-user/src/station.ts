import type { Station, Verb } from '@metro-labs/mcp/stations/types';

export const telegramUserStation: Station = {
  name: 'telegram-user',
  hasAccounts: true,
  messageVerbs: new Set<Verb>([
    'send',
    'reply',
    'react',
    'unreact',
    'edit',
    'delete',
    'read',
  ]),
  attachmentMode: 'canonical',
  tools: [],
};
