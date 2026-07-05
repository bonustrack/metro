import type { Station, Verb } from '@metro-labs/mcp/stations/types';

export const telegramStation: Station = {
  name: 'telegram',
  hasAccounts: true,
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
