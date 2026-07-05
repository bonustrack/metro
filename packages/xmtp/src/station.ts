import type { Station, Verb } from '@metro-labs/mcp/stations/types';
import { XMTP_TOOLS, xmtpSendAttachments } from './tools.js';

export const xmtpStation: Station = {
  name: 'xmtp',
  hasAccounts: true,
  messageVerbs: new Set<Verb>(['send', 'reply', 'react', 'unreact', 'read']),
  attachmentMode: 'native',
  sendAttachments: xmtpSendAttachments,
  tools: XMTP_TOOLS,
};
