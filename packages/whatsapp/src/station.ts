import type { Station, Verb } from '@metro-labs/mcp/stations/types';

export const whatsappStation: Station = {
  name: 'whatsapp',
  hasAccounts: true,
  messageVerbs: new Set<Verb>([
    'send',
    'reply',
    'react',
    'unreact',
    'edit',
    'delete',
  ]),
  attachmentMode: 'none',
  tools: [],
};
