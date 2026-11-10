import type { MetroEvent } from '@metro-labs/core/events';
import { log } from '@metro-labs/core/log';
import { agentNameOf, knownAgentIds } from '../agents/map.js';
import { connectorEvent } from '../channels/connector-event.js';
import type { TakeEvent } from '../mcp-server/event-intake.js';

export function connectorEventTaker(publish: (event: MetroEvent) => void, live: () => boolean): TakeEvent {
  return (event) => {
    const agentId = knownAgentIds()[0];
    if (agentId === undefined) return null;
    if (!live()) {
      log.info({ event: event.id, connector: event.connector.id }, 'mcp-server: messages are paused, so a connector event is dropped');
      return 'paused';
    }
    publish(connectorEvent(event, agentId, agentNameOf(agentId)));
    log.info({ event: event.id, connector: event.connector.id, name: event.event }, 'mcp-server: a connector event reached the agent');
    return 'delivered';
  };
}
