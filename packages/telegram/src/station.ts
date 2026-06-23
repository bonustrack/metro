import type { Station, Verb } from '@metro-labs/mcp/stations/types';
import { Line } from '@metro-labs/mcp/lines';

const MUTATES: ReadonlySet<string> = new Set([
  'send',
  'react',
  'edit',
  'delete',
  'send_photo',
  'send_document',
  'send_voice',
  'send_sticker',
  'send_dice',
  'send_location',
]);

export const telegramStation: Station = {
  name: 'telegram',
  hasAccounts: true,
  messageVerbs: new Set<Verb>([
    'send',
    'reply',
    'react',
    'unreact',
    'edit',
    'delete',
  ]),
  attachmentMode: 'canonical',
  parseLine: (line) => {
    const p = Line.parse(line);
    if (p?.station !== 'telegram' || !p.path.length) return null;
    const [first, ...rest] = p.path;
    if (first === undefined) return null;
    return rest.length
      ? { accountId: first, resource: rest.join('/') }
      : { accountId: 'default', resource: first };
  },
  mutates: MUTATES,
  tools: [],
};
