import type { GroupOp, Station, Verb } from '@metro-labs/mcp/stations/types';

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
  ]),
  groupOps: new Set<GroupOp>(['create_group', 'add_members', 'remove_members']),
  attachmentMode: 'canonical',
  tools: [],
};
