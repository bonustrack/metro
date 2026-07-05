import { randomBytes } from 'node:crypto';
import { Line } from '../stations/lines.js';

export { userSelf, daemonSelf, selfLine } from './identity.js';

export type StructuredEvent =
  | { type: 'msg' }
  | { type: 'react'; emoji?: string; targetId?: string }
  | { type: 'edit'; targetId?: string }
  | { type: 'delete'; targetId?: string }
  | { type: 'reply'; replyTo?: string }
  | { type: 'system'; source?: string; eventName?: string };

export interface MetroEvent {
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

function isExternalWebhook(e: MetroEvent): boolean {
  return e.station === 'webhook' && !Line.isLocal(e.from);
}

function webhookEventName(e: MetroEvent): string | undefined {
  const headers = (e.payload as { headers?: Record<string, string> } | undefined)
    ?.headers;
  return headers?.['x-github-event'] ?? headers?.['x-intercom-topic'];
}

export function classifyEvent(e: MetroEvent): StructuredEvent {
  if (isExternalWebhook(e)) {
    return {
      type: 'system',
      source: 'webhook',
      eventName: webhookEventName(e),
    };
  }
  const emoji =
    (e.payload as { emoji?: string } | undefined)?.emoji ??
    e.text?.match(/^\[react (.+)\]$/)?.[1];
  if (emoji) return { type: 'react', emoji, targetId: e.replyTo };
  if (e.replyTo) return { type: 'reply', replyTo: e.replyTo };
  return { type: 'msg' };
}

export function formatDisplay(e: MetroEvent): string {
  const headerFor = (icon: string, parts: (string | undefined)[]): string =>
    `**${icon} ${parts.filter(Boolean).join(' · ')}**`;
  const body = e.text ?? '';
  if (isExternalWebhook(e)) {
    const ev = webhookEventName(e);
    return `${headerFor('🪝', ['webhook', e.lineName, ev])}\n> ${body}`;
  }
  if (Line.isLocal(e.from)) {
    return `${headerFor('📤', [e.station, '→', e.fromName ?? e.to])}\n> ${body}`;
  }
  return `${headerFor('📩', [e.station, e.fromName ?? e.from, e.lineName])}\n> ${body}`;
}

export const mintId = (): string =>
  `msg_${randomBytes(6).toString('base64url')}`;

export type BusListener = (event: MetroEvent, busSeq: number) => void;

export interface BufferedEvent {
  busSeq: number;
  event: MetroEvent;
}

export const BUS_BUFFER_MAX = 500;

const listeners = new Set<BusListener>();
const buffer: BufferedEvent[] = [];
let busSeq = 0;

export function publishEvent(event: MetroEvent): void {
  busSeq += 1;
  const seq = busSeq;
  buffer.push({ busSeq: seq, event });
  if (buffer.length > BUS_BUFFER_MAX) buffer.shift();
  for (const fn of [...listeners]) {
    try {
      fn(event, seq);
    } catch (err) {
      console.error('[metro-bus] listener threw for busSeq', seq, err);
    }
  }
}

export function currentBusSeq(): number {
  return busSeq;
}

export function bufferedSince(afterBusSeq: number): BufferedEvent[] {
  return buffer.filter((b) => b.busSeq > afterBusSeq);
}

export function subscribeEvents(fn: BusListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
