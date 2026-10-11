import { parseId } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { connectorAuth, connectorName } from '@metro-labs/http/connector-input';
import { verifyRemoteMcp } from '@metro-labs/http/connector-mcp';
import { parseConnectorUrl } from '@metro-labs/http/connector-url';
import type { ConnectorEdit, ConnectorRow, EventView } from '../db/connectors.js';
import { connectorView, detailOf, detailText, isReadOnly, openConnectorSecret, readOnlyPolicy, sealConnectorSecret, type ConnectorView } from './model.js';
import { sealingKey, viewOf, type ActionDeps, type Caller } from './actions.js';

const EVENTS_PAGE = 50;
const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

type Change = { kind: 'name'; name: string } | { kind: 'readOnly'; readOnly: boolean } | { kind: 'key'; header: unknown; value: unknown };

const actorOf = (caller: Caller): string => `user:${caller.session.userId}`;
const at = (deps: ActionDeps): string => new Date(deps.now()).toISOString();

export async function listConnectors(deps: ActionDeps, owner: string): Promise<ConnectorView[]> {
  const { connectors, assignments } = await deps.store.list(owner);
  return connectors.map((row) => connectorView(row, assignments));
}

function changeOf(body: unknown): Change {
  const input = isRecord(body) ? body : {};
  const asked = ['name', 'readOnly', 'value'].filter((field) => input[field] !== undefined);
  if (asked.length !== 1) throw new ApiError('Send one change at a time: a name, readOnly, or a new key with its header.', 400);
  if (input.name !== undefined) return { kind: 'name', name: connectorName(input.name) };
  if (input.readOnly !== undefined) {
    if (typeof input.readOnly !== 'boolean') throw new ApiError('readOnly must be true or false', 400);
    return { kind: 'readOnly', readOnly: input.readOnly };
  }
  return { kind: 'key', header: input.header, value: input.value };
}

function event(caller: Caller, row: ConnectorRow, action: string, detail: Record<string, string>): ConnectorEdit['event'] {
  return { owner: caller.owner, connector: row.id, actor: actorOf(caller), action, detail: { name: row.name, ...detail } };
}

function simpleEdit(caller: Caller, change: Exclude<Change, { kind: 'key' }>): (row: ConnectorRow) => ConnectorEdit {
  return (row) => {
    if (change.kind === 'name')
      return row.name === change.name ? { change: {}, event: null } : { change: { name: change.name }, event: event(caller, row, 'connector.renamed', { to: change.name }) };
    if (isReadOnly(row.policy) === change.readOnly) return { change: {}, event: null };
    return { change: { policy: readOnlyPolicy(change.readOnly) }, event: event(caller, row, 'connector.read_only_changed', { readOnly: change.readOnly ? 'yes' : 'no' }) };
  };
}

async function keyEdit(deps: ActionDeps, caller: Caller, id: string, change: Extract<Change, { kind: 'key' }>): Promise<(row: ConnectorRow) => ConnectorEdit> {
  const key = sealingKey(deps);
  const auth = connectorAuth(change.header, change.value);
  if (auth.kind !== 'header') throw new ApiError('Give the new key, and its header if it is not Authorization.', 400);
  const row = await deps.store.find(caller.owner, id);
  if (row === null) throw new ApiError('no such connector', 404);
  if (row.auth === 'oauth') throw new ApiError('This connector signs in with OAuth. Sign in again instead.', 400);
  const secret = openConnectorSecret(key, row);
  if (secret === null) throw new ApiError('The connection address could not be opened. Add the connector again.', 400);
  const verified = await verifyRemoteMcp(parseConnectorUrl(secret.targetUrl), auth, deps.fetch);
  const now = at(deps);
  return (current) => {
    if (current.auth === 'oauth') throw new ApiError('This connector signs in with OAuth. Sign in again instead.', 400);
    const detail = { ...detailOf(current.detail), header: auth.name, server: verified.server, verifiedAt: now };
    return {
      change: { auth: 'header', secret: sealConnectorSecret(key, current, { kind: 'header', targetUrl: secret.targetUrl, name: auth.name, value: auth.value }), detail: detailText(detail) },
      event: event(caller, current, 'connector.key_changed', { header: auth.name }),
    };
  };
}

export async function updateConnector(deps: ActionDeps, caller: Caller, id: string, body: unknown): Promise<ConnectorView> {
  const change = changeOf(body);
  const edit = change.kind === 'key' ? await keyEdit(deps, caller, id, change) : simpleEdit(caller, change);
  const saved = await deps.store.edit(caller.owner, id, at(deps), edit);
  log.info({ owner: caller.owner, id: saved.id, change: change.kind }, 'org-connectors: connector changed');
  return viewOf(deps, caller.owner, id);
}

export async function deleteConnector(deps: ActionDeps, caller: Caller, id: string): Promise<{ id: string; deleted: true }> {
  const gone = await deps.store.remove(caller.owner, id, at(deps), (row) => ({
    owner: caller.owner,
    connector: row.id,
    actor: actorOf(caller),
    action: 'connector.deleted',
    detail: { name: row.name, host: new URL(row.url).hostname },
  }));
  log.info({ owner: caller.owner, id: gone.id }, 'org-connectors: connector removed');
  return { id: gone.id, deleted: true };
}

export async function assignConnector(deps: ActionDeps, caller: Caller, id: string, agent: string, body: unknown): Promise<ConnectorView> {
  const readOnly = isRecord(body) ? body.readOnly : undefined;
  if (readOnly !== undefined && typeof readOnly !== 'boolean') throw new ApiError('readOnly must be true or false', 400);
  await deps.store.assign({ owner: caller.owner, connector: id, agent, policy: readOnlyPolicy(readOnly === true), actor: actorOf(caller), at: at(deps) });
  log.info({ owner: caller.owner, id, agent, readOnly: readOnly === true }, 'org-connectors: connector assigned');
  return viewOf(deps, caller.owner, id);
}

export async function unassignConnector(deps: ActionDeps, caller: Caller, id: string, agent: string): Promise<ConnectorView> {
  await deps.store.unassign({ owner: caller.owner, connector: id, agent, actor: actorOf(caller), at: at(deps) });
  log.info({ owner: caller.owner, id, agent }, 'org-connectors: connector unassigned');
  return viewOf(deps, caller.owner, id);
}

function detailRecord(text: string | null): Record<string, string> {
  if (text === null) return {};
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {};
  } catch {
    return {};
  }
}

function eventView(row: EventView): Record<string, unknown> {
  const detail = detailRecord(row.detail);
  return {
    id: row.id,
    at: row.at,
    action: row.action,
    actor: row.actor.startsWith('user:') ? { kind: 'user', id: row.actor.slice(5), name: row.actorName, email: row.actorEmail } : { kind: row.actor },
    connector: row.connector === null ? null : { id: row.connector, name: detail.name ?? row.connectorName ?? null },
    agent: row.agent === null ? null : { id: row.agent, name: row.agentName },
    detail,
  };
}

function pageOf(query: URLSearchParams): { connector?: string; before?: { at: string; id: string } } {
  const connector = query.get('connector');
  const beforeAt = query.get('before');
  const beforeId = query.get('beforeId');
  const page: { connector?: string; before?: { at: string; id: string } } = {};
  if (connector !== null) {
    const id = parseId(connector);
    if (id === null) throw new ApiError('no such connector', 404);
    page.connector = id;
  }
  if (beforeAt !== null || beforeId !== null) {
    const id = parseId(beforeId ?? '');
    if (beforeAt === null || !AT_RE.test(beforeAt) || id === null) throw new ApiError('before and beforeId must come from the last page', 400);
    page.before = { at: beforeAt, id };
  }
  return page;
}

export async function listConnectorEvents(deps: ActionDeps, owner: string, query: URLSearchParams): Promise<{ events: Record<string, unknown>[]; next: { before: string; beforeId: string } | null }> {
  const rows = await deps.store.events(owner, { ...pageOf(query), limit: EVENTS_PAGE });
  const last = rows.length === EVENTS_PAGE ? rows[rows.length - 1] : undefined;
  return { events: rows.map(eventView), next: last === undefined ? null : { before: last.at, beforeId: last.id } };
}
