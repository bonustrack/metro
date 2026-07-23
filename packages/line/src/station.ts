import type { Station, Verb } from '@metro-labs/mcp/stations/types';

export const lineStation: Station = {
  name: 'line',
  hasAccounts: true,
  messageVerbs: new Set<Verb>(['send', 'reply']),
  attachmentMode: 'none',
  tools: [],
};
