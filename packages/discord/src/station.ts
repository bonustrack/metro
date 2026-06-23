import type { Station, Verb } from '@metro-labs/station-kit/types';
import { parseAccountScoped } from '@metro-labs/metro/lines';

const isSnowflake = (s: string): boolean => /^\d+$/.test(s);

const MUTATES: ReadonlySet<string> = new Set([
  'send',
  'reply',
  'react',
  'edit',
  'delete',
  'thread_create',
  'pin',
  'typing',
  'set_presence',
  'joinVoice',
  'leaveVoice',
  'speak',
  'voiceTranscribe',
]);

export const discordStation: Station = {
  name: 'discord',
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
  parseLine: (line) => parseAccountScoped(line, 'discord', isSnowflake),
  mutates: MUTATES,
  tools: [],
};
