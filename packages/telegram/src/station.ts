import type { Station, Verb } from '@metro-labs/metro/stations/types';
import { Line } from '@metro-labs/metro/lines';

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
    return p.path.length >= 2
      ? { accountId: p.path[0], resource: p.path.slice(1).join('/') }
      : { accountId: 'default', resource: p.path[0] };
  },
  mutates: MUTATES,
  tools: [],
};
