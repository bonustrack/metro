import type { Station, Verb } from '@metro-labs/mcp/stations/types';
import { parseAccountScoped } from '@metro-labs/mcp/lines';

const MUTATES: ReadonlySet<string> = new Set([
  'send',
  'react',
  'edit',
  'delete',
]);

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
  attachmentMode: 'canonical',
  parseLine: (line) => parseAccountScoped(line, 'telegram-user'),
  mutates: MUTATES,
  tools: [],
};
