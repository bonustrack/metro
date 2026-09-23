import type { ReadFilter, Station, Verb } from '@metro-labs/core/stations/types';
import { stateFiles } from './state.js';

export const outlookStation: Station = {
  name: 'outlook',
  hasAccounts: true,
  hasTrain: true,
  messageVerbs: new Set<Verb>(['send', 'reply', 'read']),
  readFilters: new Set<ReadFilter>(['account', 'query', 'from', 'until', 'unread_only', 'message_id']),
  approvals: false,
  attachmentMode: 'canonical',
  forget: stateFiles.forget,
  forgetExcept: stateFiles.forgetExcept,
  tools: [],
};
