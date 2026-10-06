import type { Station, Verb } from '@metro-labs/core/stations/types';
import { PROFILE_FIELDS, type ProfileField } from '@metro-labs/core/stations/profile';
import { tokenFiles } from './token-store.js';
import { nameFiles } from './names.js';
import { historyFiles } from './history-files.js';
import { channelFiles } from './channel-chats.js';

export const whatsappStation: Station = {
  name: 'whatsapp',
  hasAccounts: true,
  hasTrain: true,
  messageVerbs: new Set<Verb>([
    'read',
    'send',
    'reply',
    'react',
    'unreact',
    'edit',
    'delete',
    'typing',
  ]),
  attachmentMode: 'canonical',
  profileFields: new Set<ProfileField>(PROFILE_FIELDS),
  readsProfiles: true,
  resolvesSenders: true,
  discoversChannels: true,
  forget: (accountId) => {
    tokenFiles.forget(accountId);
    nameFiles.forget(accountId);
    historyFiles.forget(accountId);
    channelFiles.forget(accountId);
  },
  forgetExcept: (kept) => {
    tokenFiles.forgetExcept(kept);
    nameFiles.forgetExcept(kept);
    historyFiles.forgetExcept(kept);
    channelFiles.forgetExcept(kept);
  },
  tools: [],
};
