import type { GroupOp, Station, Verb } from '@metro-labs/mcp/stations/types';

export const telegramUserStation: Station = {
  name: 'telegram-user',
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
  groupOps: new Set<GroupOp>([
    'create_group',
    'add_members',
    'remove_members',
    'invite_link',
  ]),
  attachmentMode: 'canonical',
  tools: [],
};
