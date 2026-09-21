import type { GroupOp, Station, Verb } from '@metro-labs/core/stations/types';
import { PROFILE_FIELDS, type ProfileField } from '@metro-labs/core/stations/profile';
import { XMTP_TOOLS, xmtpSendAttachments } from './tools.js';

export const xmtpStation: Station = {
  name: 'xmtp',
  hasAccounts: true,
  hasTrain: true,
  messageVerbs: new Set<Verb>(['send', 'reply', 'react', 'unreact', 'read']),
  groupOps: new Set<GroupOp>(['create_group', 'add_members', 'remove_members']),
  attachmentMode: 'native',
  profileFields: new Set<ProfileField>(PROFILE_FIELDS),
  claimsName: true,
  sendAttachments: xmtpSendAttachments,
  tools: XMTP_TOOLS,
};
