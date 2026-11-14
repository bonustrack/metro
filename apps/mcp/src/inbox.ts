import { log } from '@metro-labs/core/log';
import type { McpConnectorEvent, McpSettled } from '@metro-labs/http/mcp-server-protocol';
import type { AgentKeyRow } from '@metro-labs/connectors/db/agent-keys';
import { failureText, isNotMigrated } from '@metro-labs/connectors/db/errors';
import type { McpDeps } from './deps.js';
import { inboxWaiter, settleEvents, waitingEvents } from './events.js';

type InboxDeps = Pick<McpDeps, 'key' | 'store' | 'events' | 'calls' | 'waiters' | 'now' | 'inboxHoldMs' | 'inboxCheckMs'>;

let quiet = false;

async function quietly<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    const done = await work();
    quiet = false;
    return done;
  } catch (err) {
    if (!quiet) {
      if (isNotMigrated(err)) log.warn('mcp: the connector event tables are not migrated yet, so agents get no events until api.metro.box migrates');
      else log.warn({ err: failureText(err) }, 'mcp: connector events could not be read, later failures stay quiet until one works');
    }
    quiet = true;
    return null;
  }
}

async function held(deps: InboxDeps, identity: AgentKeyRow, hold: AbortSignal, watching: boolean): Promise<McpConnectorEvent[]> {
  while (!hold.aborted) {
    const notified = await deps.waiters.wait(inboxWaiter(identity.agent), watching ? deps.inboxCheckMs : deps.inboxHoldMs, hold);
    const events = notified || watching ? await quietly(() => waitingEvents(deps, identity)) : null;
    if (events !== null && events.length > 0) return events;
  }
  return [];
}

export async function inboxFor(deps: InboxDeps, identity: AgentKeyRow, settled: McpSettled[], signal: AbortSignal): Promise<McpConnectorEvent[]> {
  if (settled.length > 0) await quietly(() => settleEvents(deps, identity, settled));
  const hold = AbortSignal.any([signal, AbortSignal.timeout(deps.inboxHoldMs)]);
  const first = await quietly(() => waitingEvents(deps, identity));
  if (first !== null && first.length > 0) return first;
  const watching = first !== null && (await quietly(() => deps.events.subscribed(identity))) === true;
  return held(deps, identity, hold, watching);
}
