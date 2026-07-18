import type { GroupOp, Station, Verb } from '@metro-labs/mcp/stations/types';
import { XMTP_TOOLS, xmtpSendAttachments } from './tools.js';

export const xmtpStation: Station = {
  name: 'xmtp',
  hasAccounts: true,
  messageVerbs: new Set<Verb>(['send', 'reply', 'react', 'unreact', 'read']),
  groupOps: new Set<GroupOp>(['create_group', 'add_members', 'remove_members']),
  attachmentMode: 'native',
  sendAttachments: xmtpSendAttachments,
  tools: XMTP_TOOLS,
};
