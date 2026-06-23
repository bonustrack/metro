import { randomBytes } from 'node:crypto';
import { Line } from '../stations/lines.js';

export { userSelf, daemonSelf, selfLine } from './identity.js';

export type StructuredEvent =
  | { type: 'msg' }
  | { type: 'react'; emoji?: string; targetId?: string }
  | { type: 'edit'; targetId?: string }
  | { type: 'delete'; targetId?: string }
  | { type: 'reply'; replyTo?: string }
  | { type: 'system'; source?: string; eventName?: string }
  | { type: 'push-ack'; targetId?: string };

export type WireEvent = StructuredEvent;

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

export type BusListener = (event: MetroEvent) => void;

const listeners = new Set<BusListener>();

export function publishEvent(event: MetroEvent): void {
  for (const fn of [...listeners]) {
    try {
      fn(event);
    } catch {
    }
  }
}

export function subscribeEvents(fn: BusListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
