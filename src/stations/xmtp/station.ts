import type { Station, Verb } from '../types.js';
import { parseAccountScoped } from '../../lines.js';
import { XMTP_TOOLS, xmtpSendAttachments } from './tools.js';

const MUTATES: ReadonlySet<string> = new Set([
  'send',
  'reply',
  'react',
  'sendAttachment',
  'sendImage',
  'ask',
  'sendPoll',
  'sendTxRequest',
  'sendSignatureRequest',
  'edit',
  'delete',
  'newDm',
  'newGroup',
  'createRequestGroup',
  'addMembers',
  'setLabels',
  'setGithub',
  'setPreview',
  'updateChannelMeta',
  'closeGroup',
  'register-push',
  'test-push',
  'unregister-push',
  'disable-push',
]);

export const xmtpStation: Station = {
  name: 'xmtp',
  hasAccounts: true,
  messageVerbs: new Set<Verb>(['send', 'reply', 'react', 'unreact', 'read']),
  attachmentMode: 'native',
  sendAttachments: xmtpSendAttachments,
  parseLine: (line) => parseAccountScoped(line, 'xmtp'),
  mutates: MUTATES,
  tools: XMTP_TOOLS,
};
