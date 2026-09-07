import { str } from '../mcp/str.js';

export type Addressed = 'direct' | 'mention' | 'reply';

interface AddressFacts {
  isPrivate?: unknown;
  mentionsSelf?: unknown;
  replyToSelf?: unknown;
}

export function addressedBy(facts: AddressFacts, replyTo: string, sent: ReadonlySet<string>): Addressed | undefined {
  if (facts.isPrivate === true) return 'direct';
  if (facts.mentionsSelf === true) return 'mention';
  if (facts.replyToSelf === true || (replyTo !== '' && sent.has(replyTo))) return 'reply';
  return undefined;
}

export function replyMeta(ev: Record<string, unknown>, sent: ReadonlySet<string>): Record<string, string> {
  const replyTo = str(ev.replyTo);
  const addressed = addressedBy(ev, replyTo, sent);
  return {
    ...(replyTo ? { reply_to: replyTo } : {}),
    ...(addressed === undefined ? {} : { addressed }),
  };
}
