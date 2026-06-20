/** XMTP station manifest — the platform-agnostic surface core consumes. */
import type { Station, Verb } from '../types.js';
import { parseAccountScoped } from '../../lines.js';
import { XMTP_VERBS } from './verbs.js';

export const xmtpStation: Station = {
  name: 'xmtp',
  hasAccounts: true,
  supports: new Set<Verb>(['send', 'reply', 'react', 'unreact', 'read']),
  attachmentMode: 'native',
  parseLine: line => parseAccountScoped(line, 'xmtp'),
  verbs: XMTP_VERBS,
  tools: [], // the xmtp-specific MCP tools (create_channel, dm, ask, …) move here next
};
