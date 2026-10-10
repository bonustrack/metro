import { newId } from '@metro-labs/core/ids';
import type { connectorEvents } from './schema.js';

export interface ConnectorEvent {
  owner: string;
  actor: string;
  action: string;
  connector?: string;
  agent?: string;
  detail?: Record<string, string>;
}

export const eventRow = (event: ConnectorEvent, at: string): typeof connectorEvents.$inferInsert => ({
  id: newId(),
  owner: event.owner,
  connector: event.connector ?? null,
  agent: event.agent ?? null,
  actor: event.actor,
  action: event.action,
  detail: event.detail === undefined ? null : JSON.stringify(event.detail),
  at,
});
