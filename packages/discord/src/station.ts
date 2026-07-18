import type { GroupOp, Station, Verb } from '@metro-labs/mcp/stations/types';

export const discordStation: Station = {
  name: 'discord',
  hasAccounts: true,
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
