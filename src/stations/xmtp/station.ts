/** XMTP station manifest — the platform-agnostic surface core consumes. */
import type { Station, Verb } from '../types.js';
import { parseAccountScoped } from '../../lines.js';
import { XMTP_VERBS } from './verbs.js';
import { XMTP_TOOLS, xmtpSendAttachments } from './tools.js';

export const xmtpStation: Station = {
  name: 'xmtp',
  hasAccounts: true,
  supports: new Set<Verb>(['send', 'reply', 'react', 'unreact', 'read']),
  attachmentMode: 'native',
  sendAttachments: xmtpSendAttachments,
  parseLine: line => parseAccountScoped(line, 'xmtp'),
  verbs: XMTP_VERBS,
  tools: XMTP_TOOLS,
};
