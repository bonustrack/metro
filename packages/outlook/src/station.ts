import type { ReadFilter, Station, Verb } from '@metro-labs/core/stations/types';

export const outlookStation: Station = {
  name: 'outlook',
  hasAccounts: true,
  hasTrain: true,
  messageVerbs: new Set<Verb>(['send', 'reply', 'read']),
  readFilters: new Set<ReadFilter>(['account', 'query', 'from', 'until', 'unread_only', 'message_id']),
  approvals: false,
  attachmentMode: 'canonical',
  tools: [],
};
