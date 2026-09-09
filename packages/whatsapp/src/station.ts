import type { Station, Verb } from '@metro-labs/core/stations/types';

export const whatsappStation: Station = {
  name: 'whatsapp',
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
