/** Webhook station manifest — inbound-only (no accounts, no outbound verbs/tools).
 *  The HTTP receiver itself stays in core (generic transport); this declares the
 *  webhook line shape + capabilities so core never special-cases "webhook". */
import type { Station, Verb } from '../types.js';
import { Line } from '../../lines.js';

export const webhookStation: Station = {
  name: 'webhook',
  hasAccounts: false,
  supports: new Set<Verb>(),
  attachmentMode: 'none',
  parseLine: line => {
    const p = Line.parse(line);
    return p?.station === 'webhook' && p.path.length
      ? { accountId: 'default', resource: p.path.join('/') }
      : null;
  },
  verbs: [],
  tools: [],
};
