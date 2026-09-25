import type { GroupOp, Station, Verb } from '@metro-labs/core/stations/types';
import { PROFILE_FIELDS, type ProfileField } from '@metro-labs/core/stations/profile';

export const discordBotStation: Station = {
  name: 'discord-bot',
  hasAccounts: true,
  hasTrain: true,
  messageVerbs: new Set<Verb>([
    'send',
    'reply',
    'react',
    'unreact',
    'edit',
    'delete',
    'read',
    'typing',
  ]),
  groupOps: new Set<GroupOp>(['create_group', 'add_members', 'remove_members']),
  attachmentMode: 'canonical',
  profileFields: new Set<ProfileField>(PROFILE_FIELDS),
  readsProfiles: true,
  tools: [],
};
