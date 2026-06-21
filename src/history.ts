import { randomBytes } from 'node:crypto';
import { Line } from './lines.js';

export {
  userSelf,
  daemonSelf,
  selfLine,
  noteUserFromLine,
} from './history-identity.js';
export type {
  StructuredEvent,
  WireEvent,
  HistoryEntry,
} from './history-types.js';

import type { HistoryEntry, StructuredEvent } from './history-types.js';

function isExternalWebhook(e: HistoryEntry): boolean {
  return e.station === 'webhook' && !Line.isLocal(e.from);
}

function webhookEventName(e: HistoryEntry): string | undefined {
  const headers = (e.payload as { headers?: Record<string, string> } | undefined)
    ?.headers;
  return headers?.['x-github-event'] ?? headers?.['x-intercom-topic'];
}

export function classifyEvent(e: HistoryEntry): StructuredEvent {
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

export function formatDisplay(e: HistoryEntry): string {
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
