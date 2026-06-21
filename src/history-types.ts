import { Line } from './lines.js';

export type StructuredEvent =
  | { type: 'msg' }
  | { type: 'react'; emoji?: string; targetId?: string }
  | { type: 'edit'; targetId?: string }
  | { type: 'delete'; targetId?: string }
  | { type: 'reply'; replyTo?: string }
  | { type: 'system'; source?: string; eventName?: string }
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
