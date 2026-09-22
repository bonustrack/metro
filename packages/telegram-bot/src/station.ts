import type { Station, Verb } from '@metro-labs/core/stations/types';
import { PROFILE_FIELDS, type ProfileField } from '@metro-labs/core/stations/profile';

export const telegramBotStation: Station = {
  name: 'telegram-bot',
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
  profileFields: new Set<ProfileField>(PROFILE_FIELDS),
  readsProfiles: true,
  tools: [],
};
