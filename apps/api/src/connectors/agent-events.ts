import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { EVENT_NAME_RE } from '@metro-labs/http/mcp-events';
import { normalizeSenderList } from '@metro-labs/http/sender-list';
import { EVENTS_MAX } from '@metro-labs/connectors/db/connectors';
import { viewOf, type ActionDeps, type Caller } from './actions.js';
import type { ConnectorView } from './model.js';

const FIELDS = ['events', 'senders'];

function eventNames(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > EVENTS_MAX) throw new ApiError(`events must be a list of at most ${String(EVENTS_MAX)} event names.`, 400);
  const names = new Set<string>();
  for (const name of raw) {
    if (typeof name !== 'string' || !EVENT_NAME_RE.test(name)) throw new ApiError('An event name is 1 to 128 letters, digits, dots, colons, slashes, dashes or underscores, and starts with a letter or a digit.', 400);
    names.add(name);
  }
  return [...names];
}

function changeOf(body: unknown): { events?: string[]; senders?: string[] } {
  const input = isRecord(body) ? body : {};
  const asked = Object.keys(input);
  if (asked.length === 0 || asked.some((key) => !FIELDS.includes(key))) throw new ApiError('Send events, senders, or both for this agent, and nothing else.', 400);
  return {
    ...(Object.hasOwn(input, 'events') ? { events: eventNames(input.events) } : {}),
    ...(Object.hasOwn(input, 'senders') ? { senders: normalizeSenderList(input.senders) } : {}),
  };
}

export async function updateConnectorAgentEvents(deps: ActionDeps, caller: Caller, id: string, agent: string, body: unknown): Promise<ConnectorView> {
  const change = changeOf(body);
  await deps.store.setEvents({ owner: caller.owner, connector: id, agent, ...change });
  log.info({ owner: caller.owner, id, agent, events: change.events?.length ?? null, senders: change.senders?.length ?? null }, 'org-connectors: agent events changed');
  return viewOf(deps, caller.owner, id);
}
