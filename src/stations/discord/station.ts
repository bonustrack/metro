import type { Station, Verb } from '../types.js';
import { parseAccountScoped } from '../../lines.js';
import { DISCORD_VERBS } from './verbs.js';

const isSnowflake = (s: string): boolean => /^\d+$/.test(s);

export const discordStation: Station = {
  name: 'discord',
  hasAccounts: true,
  supports: new Set<Verb>([
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
  verbs: DISCORD_VERBS,
  tools: [],
};
