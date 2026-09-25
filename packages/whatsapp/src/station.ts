import type { Station, Verb } from '@metro-labs/core/stations/types';
import { PROFILE_FIELDS, type ProfileField } from '@metro-labs/core/stations/profile';
import { tokenFiles } from './token-store.js';
import { nameFiles } from './names.js';

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
    'typing',
  ]),
  attachmentMode: 'canonical',
  profileFields: new Set<ProfileField>(PROFILE_FIELDS),
  readsProfiles: true,
  resolvesSenders: true,
  forget: (accountId) => {
    tokenFiles.forget(accountId);
    nameFiles.forget(accountId);
  },
  forgetExcept: (kept) => {
    tokenFiles.forgetExcept(kept);
    nameFiles.forgetExcept(kept);
  },
  tools: [],
};
