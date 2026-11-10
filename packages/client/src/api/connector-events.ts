import { filled, isRecord, str } from '../read.js';
import { EVERYONE } from './accounts.js';

export const CONNECTOR_EVENTS_SINCE = '0.1.0-beta.330';

type SubscriptionStatus = 'pending' | 'active' | 'signed_out' | 'error';

export interface OfferedEvent {
  name: string;
  title: string;
  description: string;
  sender: boolean;
}

export interface EventSubscription {
  event: string;
  status: SubscriptionStatus;
  error: string | null;
}

export interface AgentEvents {
  events: string[];
  senders: string[];
  subscriptions: EventSubscription[];
}

export interface AgentEventsChange {
  events?: string[];
  senders?: string[];
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && entry !== ''))] : []);

const statusOf = (value: unknown): SubscriptionStatus => (value === 'active' || value === 'signed_out' || value === 'error' ? value : 'pending');

function offeredEvent(value: unknown): OfferedEvent[] {
  if (!isRecord(value) || typeof value.name !== 'string' || value.name === '') return [];
  return [{ name: value.name, title: filled(value.title) ?? value.name, description: str(value.description), sender: value.sender === true }];
}

export const offeredEventsOf = (value: unknown): OfferedEvent[] | null => (Array.isArray(value) ? value.flatMap(offeredEvent) : null);

function sendersOf(value: unknown): string[] {
  const list = strings(value);
  return list.length === 0 || list.includes(EVERYONE) ? [EVERYONE] : list;
}

function subscription(value: unknown): EventSubscription[] {
  if (!isRecord(value) || typeof value.event !== 'string' || value.event === '') return [];
  return [{ event: value.event, status: statusOf(value.status), error: filled(value.error) }];
}

export function agentEventsOf(value: Record<string, unknown>): AgentEvents {
  return { events: strings(value.events), senders: sendersOf(value.senders), subscriptions: Array.isArray(value.subscriptions) ? value.subscriptions.flatMap(subscription) : [] };
}
