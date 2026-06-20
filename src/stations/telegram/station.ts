/** Telegram station manifest — the platform-agnostic surface core consumes. */
import type { Station, Verb } from '../types.js';
import { Line } from '../../lines.js';
import { TELEGRAM_VERBS } from './verbs.js';

export const telegramStation: Station = {
  name: 'telegram',
  hasAccounts: true,
  supports: new Set<Verb>(['send', 'reply', 'react', 'unreact', 'edit', 'delete']),
  attachmentMode: 'canonical',
  // metro://telegram/<account>/<chat>[/<topic>]; legacy metro://telegram/<chat> → default.
  parseLine: line => {
    const p = Line.parse(line);
    if (p?.station !== 'telegram' || !p.path.length) return null;
    return p.path.length >= 2
      ? { accountId: p.path[0], resource: p.path.slice(1).join('/') }
      : { accountId: 'default', resource: p.path[0] };
  },
  verbs: TELEGRAM_VERBS,
  tools: [],
};
