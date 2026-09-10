import type { Station, Verb } from '@metro-labs/core/stations/types';

export const threemaStation: Station = {
  name: 'threema',
  hasAccounts: true,
  hasTrain: true,
  messageVerbs: new Set<Verb>(['send', 'reply']),
  attachmentMode: 'none',
  tools: [],
};
