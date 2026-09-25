import type { Station, Verb } from '@metro-labs/core/stations/types';
import { PROFILE_FIELDS, type ProfileField } from '@metro-labs/core/stations/profile';
import { tokenFiles } from './token-store.js';

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
  forget: tokenFiles.forget,
  forgetExcept: tokenFiles.forgetExcept,
  tools: [],
};
