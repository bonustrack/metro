import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { EVENT_NAME_RE } from '@metro-labs/http/mcp-events';
import { normalizeSenderList } from '@metro-labs/http/sender-list';
import { eventNamesOf } from '@metro-labs/connectors/db/connector-subscriptions';
import { viewOf, type ActionDeps, type Caller } from './actions.js';
import type { ConnectorView } from './model.js';

const EVENTS_MAX = 50;
const FIELDS = ['events', 'senders'];

interface EventsChange {
  events?: string[];
  senders?: string[];
}

function eventNames(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > EVENTS_MAX) throw new ApiError(`events must be a list of at most ${String(EVENTS_MAX)} event names.`, 400);
  const names = new Set<string>();
  for (const name of raw) {
    if (typeof name !== 'string' || !EVENT_NAME_RE.test(name)) throw new ApiError('An event name is 1 to 128 letters, digits, dots, colons, slashes, dashes or underscores, and starts with a letter or a digit.', 400);
    names.add(name);
  }
  return [...names];
}

function changeOf(body: unknown): EventsChange {
  const asked = isRecord(body) ? Object.keys(body) : [];
  if (asked.length === 0 || asked.some((key) => !FIELDS.includes(key))) throw new ApiError('Send events, senders, or both for this agent, and nothing else.', 400);
  const input = isRecord(body) ? body : {};
  return {
    ...(Object.hasOwn(input, 'events') ? { events: eventNames(input.events) } : {}),
    ...(Object.hasOwn(input, 'senders') ? { senders: normalizeSenderList(input.senders) } : {}),
  };
}

async function checkOffered(deps: ActionDeps, owner: string, id: string, agent: string, events: string[]): Promise<void> {
  const { connectors, assignments } = await deps.store.list(owner);
  if (!connectors.some((row) => row.id === id)) throw new ApiError('no such connector', 404);
  const held = assignments.find((row) => row.connector === id && row.agent === agent);
  if (held === undefined) throw new ApiError('that agent does not have this connector', 404);
  const on = new Set(eventNamesOf(held.events));
  const added = events.filter((name) => !on.has(name));
  if (added.length === 0) return;
  const offered = new Set(((await deps.store.offered([id])).get(id) ?? []).map((event) => event.name));
  const unknown = added.find((name) => !offered.has(name));
  if (unknown !== undefined) throw new ApiError(`This connector does not offer "${unknown}".`, 400);
}

export async function updateConnectorAgentEvents(deps: ActionDeps, caller: Caller, id: string, agent: string, body: unknown): Promise<ConnectorView> {
  const change = changeOf(body);
  if (change.events !== undefined) await checkOffered(deps, caller.owner, id, agent, change.events);
  await deps.store.setEvents({ owner: caller.owner, connector: id, agent, ...change });
  log.info({ owner: caller.owner, id, agent, events: change.events?.length ?? null, senders: change.senders?.length ?? null }, 'org-connectors: agent events changed');
  return viewOf(deps, caller.owner, id);
}
