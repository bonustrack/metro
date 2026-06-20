import { Line } from './lines.js';

export type StructuredEvent =
  | { type: 'msg' }
  /** An emoji reaction to another message. `emoji` is the reaction glyph. */
  | { type: 'react'; emoji?: string; targetId?: string }
  /** An edit of a previously-sent message. */
  | { type: 'edit'; targetId?: string }
  /** A deletion of a previously-sent message. */
  | { type: 'delete'; targetId?: string }
  /** A reply that quotes/threads off another message. */
  | { type: 'reply'; replyTo?: string }
  /** A system/webhook/automation event (e.g. GitHub webhook). */
  | { type: 'system'; source?: string; eventName?: string }
  /** A push-notification delivery acknowledgement. */
  | { type: 'push-ack'; targetId?: string };

export type WireEvent = StructuredEvent;

export interface HistoryEntry {
  id: string;
  ts: string;
  station: string;
  line: Line;
  lineName?: string;
  from: Line;
  fromName?: string;
  to: Line;
  text?: string;
  messageId?: string;
  replyTo?: string;
  payload?: unknown;
  display?: string;
  event?: StructuredEvent;
  seq?: number;
}
