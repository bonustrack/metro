import type { Station, Verb } from '@metro-labs/core/stations/types';
import { groupFiles } from './groups.js';
import { chatFiles } from './chats.js';

export const threemaStation: Station = {
  name: 'threema',
  hasAccounts: true,
  hasTrain: true,
  discoversChannels: true,
  messageVerbs: new Set<Verb>(['send', 'reply', 'react', 'unreact']),
  attachmentMode: 'canonical',
  forget(accountId) {
    groupFiles.forget(accountId);
    chatFiles.forget(accountId);
  },
  forgetExcept(accountIds) {
    groupFiles.forgetExcept(accountIds);
    chatFiles.forgetExcept(accountIds);
  },
  tools: [],
};
