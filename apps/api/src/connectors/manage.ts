import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { connectorAuth, connectorName } from '@metro-labs/http/connector-input';
import { connectorPolicyOf, type ConnectorPolicy } from '@metro-labs/http/connector-policy';
import { verifyRemoteMcp } from '@metro-labs/http/connector-mcp';
import { parsePublicConnectorUrl } from '@metro-labs/http/connector-public-url';
import type { ConnectorEdit, ConnectorRow } from '@metro-labs/connectors/db/connectors';
import { detailOf, detailText, openConnectorSecret, sealConnectorSecret } from '@metro-labs/connectors/model';
import { sealingKey } from '@metro-labs/connectors/setup';
import { connectorView, isReadOnly, readOnlyPolicy, simplePolicy, type ConnectorView } from './model.js';
import { at, viewOf, type ActionDeps, type Caller } from './actions.js';

type Change = { kind: 'name'; name: string } | { kind: 'readOnly'; readOnly: boolean } | { kind: 'policy'; policy: ConnectorPolicy } | { kind: 'key'; header: unknown; value: unknown };

const actorOf = (caller: Caller): string => `user:${caller.session.userId}`;

export async function listConnectors(deps: ActionDeps, owner: string): Promise<ConnectorView[]> {
  const { connectors, assignments } = await deps.store.list(owner);
  return connectors.map((row) => connectorView(row, assignments));
}

function policyOf(value: unknown): ConnectorPolicy {
  try { return connectorPolicyOf(value); } catch { throw new ApiError('Invalid connector policy. Use Allow, Ask first, or Block for a group or a tool.', 400); }
}

function changeOf(body: unknown): Change {
  const input = isRecord(body) ? body : {};
  const asked = ['name', 'readOnly', 'policy', 'value'].filter((field) => Object.hasOwn(input, field));
  if (asked.length !== 1) throw new ApiError('Send one change at a time: a name, policy, readOnly, or a new key with its header.', 400);
  if (input.name !== undefined) return { kind: 'name', name: connectorName(input.name) };
  if (Object.hasOwn(input, 'policy')) return { kind: 'policy', policy: policyOf(input.policy) };
  if (Object.hasOwn(input, 'readOnly')) {
    if (typeof input.readOnly !== 'boolean') throw new ApiError('readOnly must be true or false', 400);
    return { kind: 'readOnly', readOnly: input.readOnly };
  }
  return { kind: 'key', header: input.header, value: input.value };
}

function simpleEdit(change: Exclude<Change, { kind: 'key' }>): (row: ConnectorRow) => ConnectorEdit {
  return (row) => {
    if (change.kind === 'name') return { change: row.name === change.name ? {} : { name: change.name } };
    if (change.kind === 'policy') return { change: { policy: JSON.stringify(change.policy) } };
    if (!simplePolicy(row.policy)) throw new ApiError('This connector has a custom policy. A readOnly switch cannot replace it.', 409);
    return { change: isReadOnly(row.policy) === change.readOnly ? {} : { policy: readOnlyPolicy(change.readOnly) } };
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
  const target = parsePublicConnectorUrl(secret.targetUrl);
  try { await verifyRemoteMcp(target, auth, deps.fetch); } catch { throw new ApiError('The provider could not verify the HTTP MCP endpoint with that key.', 400); }
  const now = at(deps);
  return (current) => {
    if (current.auth === 'oauth') throw new ApiError('This connector signs in with OAuth. Sign in again instead.', 400);
    const detail = { ...detailOf(current.detail), header: auth.name, server: target.hostname, verifiedAt: now };
    return { change: { auth: 'header', secret: sealConnectorSecret(key, current, { kind: 'header', targetUrl: secret.targetUrl, name: auth.name, value: auth.value }), detail: detailText(detail) } };
  };
}

export async function updateConnector(deps: ActionDeps, caller: Caller, id: string, body: unknown): Promise<ConnectorView> {
  const change = changeOf(body);
  const edit = change.kind === 'key' ? await keyEdit(deps, caller, id, change) : simpleEdit(change);
  const saved = await deps.store.edit(caller.owner, id, at(deps), edit);
  log.info({ owner: caller.owner, id: saved.id, change: change.kind }, 'org-connectors: connector changed');
  return viewOf(deps, caller.owner, id);
}

export async function deleteConnector(deps: ActionDeps, caller: Caller, id: string): Promise<{ id: string; deleted: true }> {
  const gone = await deps.store.remove(caller.owner, id);
  log.info({ owner: caller.owner, id: gone.id }, 'org-connectors: connector removed');
  return { id: gone.id, deleted: true };
}

function assignmentPolicy(body: unknown): (current: string | null) => string | null {
  if (!isRecord(body) || Object.keys(body).some((key) => key !== 'readOnly')) throw new ApiError('Send readOnly for this assignment. Use the policy endpoint for a full policy.', 400);
  if (!Object.hasOwn(body, 'readOnly')) return (current) => current;
  if (typeof body.readOnly !== 'boolean') throw new ApiError('readOnly must be true or false', 400);
  const readOnly = body.readOnly;
  return (current) => {
    if (!simplePolicy(current)) throw new ApiError('This agent has a custom policy. A readOnly switch cannot replace it.', 409);
    return readOnlyPolicy(readOnly);
  };
}

export async function assignConnector(deps: ActionDeps, caller: Caller, id: string, agent: string, body: unknown): Promise<ConnectorView> {
  await deps.store.assign({ owner: caller.owner, connector: id, agent, policy: assignmentPolicy(body), actor: actorOf(caller), at: at(deps) });
  log.info({ owner: caller.owner, id, agent }, 'org-connectors: connector assigned');
  return viewOf(deps, caller.owner, id);
}

export async function updateConnectorAgentPolicy(deps: ActionDeps, caller: Caller, id: string, agent: string, body: unknown): Promise<ConnectorView> {
  if (!isRecord(body) || !Object.hasOwn(body, 'policy') || Object.keys(body).some((key) => key !== 'policy')) throw new ApiError('Send a policy for this agent.', 400);
  await deps.store.assign({ owner: caller.owner, connector: id, agent, policy: JSON.stringify(policyOf(body.policy)), actor: actorOf(caller), at: at(deps) });
  log.info({ owner: caller.owner, id, agent }, 'org-connectors: agent policy changed');
  return viewOf(deps, caller.owner, id);
}

export async function unassignConnector(deps: ActionDeps, caller: Caller, id: string, agent: string): Promise<ConnectorView> {
  await deps.store.unassign({ owner: caller.owner, connector: id, agent });
  log.info({ owner: caller.owner, id, agent }, 'org-connectors: connector unassigned');
  return viewOf(deps, caller.owner, id);
}
