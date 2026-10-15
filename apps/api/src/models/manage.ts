import { parseId } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import type { ModelChange, ModelConnectionRow, ModelEdit } from '@metro-labs/connectors/db/models';
import { MODEL_ID_MAX, type ModelRoute } from '@metro-labs/connectors/model-route';
import { isModelProvider, KEY_PROVIDERS, modelDetailOf, modelDetailText, sealModelSecret, type ModelDetail, type ModelProvider, type ModelSecret } from '@metro-labs/connectors/model-secret';
import { isoNow, modelKey, MODELS_MAX, userActor, type Caller, type ModelsDeps } from './deps.js';
import { apiKeyOf, claudeTokenOf, creator, flagOf, LABEL_MAX, labelFor, newModelRow, regionOf, routeInput, textField } from './input.js';
import { checkClaudeToken } from './provider-lists.js';
import { connectionView, type ConnectionView, type ModelsView } from './view.js';

const PATCH_FIELDS = ['label', 'model', 'region', 'zdr', 'apiKey', 'claudeToken'];

const bad = (message: string): ApiError => new ApiError(message, 400);

export async function listModels(deps: ModelsDeps, owner: string): Promise<ModelsView> {
  const { connections, routes } = await deps.store.list(owner);
  const agents: Record<string, ModelRoute> = {};
  for (const held of routes) if (held.agent !== null) agents[held.agent] = held.route;
  return { connections: connections.map(connectionView), default: routes.find((held) => held.agent === null)?.route ?? null, agents };
}

export async function roomFor(deps: ModelsDeps, owner: string): Promise<ModelConnectionRow[]> {
  const { connections } = await deps.store.list(owner);
  if (connections.length >= MODELS_MAX) throw bad(`An organization keeps at most ${String(MODELS_MAX)} model connections. Remove one first.`);
  return connections;
}

function keyProvider(value: unknown): ModelProvider {
  if (value === 'codex') throw bad('Codex connects with a sign-in: use Continue with ChatGPT or Sign in with a code.');
  if (!isModelProvider(value) || !KEY_PROVIDERS.includes(value)) throw bad(`provider must be one of ${KEY_PROVIDERS.join(', ')}`);
  return value;
}

interface Credential {
  secret: ModelSecret;
  subscription: boolean;
}

function credentialInput(provider: ModelProvider, input: Record<string, unknown>): Credential {
  if (!Object.hasOwn(input, 'claudeToken')) return { secret: { kind: 'key', apiKey: apiKeyOf(input.apiKey) }, subscription: false };
  if (provider !== 'anthropic') throw bad('Only an Anthropic connection holds a Claude subscription token.');
  if (Object.hasOwn(input, 'apiKey')) throw bad('Send an API key or a Claude subscription token, not both.');
  return { secret: { kind: 'claude', token: claudeTokenOf(input.claudeToken) }, subscription: true };
}

const subscriptionDetail = (at: string): ModelDetail => ({ subscription: true, signedInAt: at });

export async function createModel(deps: ModelsDeps, caller: Caller, body: unknown): Promise<{ connection: ConnectionView }> {
  const key = modelKey(deps);
  const input = isRecord(body) ? body : {};
  const provider = keyProvider(input.provider);
  const { secret, subscription } = credentialInput(provider, input);
  const label = textField(input, 'label', 'label', LABEL_MAX) ?? '';
  const model = textField(input, 'model', 'model', MODEL_ID_MAX) ?? '';
  const region = regionOf(input.region);
  const zdr = flagOf(input.zdr, 'zero data retention');
  const taken = await roomFor(deps, caller.owner);
  if (secret.kind === 'claude') await checkClaudeToken(secret.token, deps.fetch);
  const at = isoNow(deps);
  const row = { ...newModelRow(creator(caller), provider, labelFor(taken, provider, label, subscription), at), model, region, zdr };
  const made: ModelConnectionRow = { ...row, secret: sealModelSecret(key, row, secret), detail: subscription ? modelDetailText(subscriptionDetail(at)) : null };
  await deps.store.create(made);
  log.info({ owner: caller.owner, id: made.id, provider, subscription }, 'models: connection added');
  return { connection: connectionView(made) };
}

function plainChange(input: Record<string, unknown>): ModelChange {
  const label = textField(input, 'label', 'label', LABEL_MAX);
  if (label === '') throw bad('a label cannot be empty');
  const model = textField(input, 'model', 'model', MODEL_ID_MAX);
  return {
    ...(label === undefined ? {} : { label }),
    ...(model === undefined ? {} : { model }),
    ...(Object.hasOwn(input, 'region') ? { region: regionOf(input.region) } : {}),
    ...(Object.hasOwn(input, 'zdr') ? { zdr: flagOf(input.zdr, 'zero data retention') } : {}),
  };
}

function keyEdit(key: Buffer, change: ModelChange, apiKey: string): (row: ModelConnectionRow) => ModelEdit {
  return (row) => {
    if (row.provider === 'codex') throw bad('Codex signs in with ChatGPT. Sign in again instead.');
    const detail = modelDetailOf(row.detail);
    if (detail.subscription === true) throw bad('This connection holds a Claude subscription. Sign in again to replace its token.');
    delete detail.signedOut;
    return { change: { ...change, secret: sealModelSecret(key, row, { kind: 'key', apiKey }), detail: modelDetailText(detail) }, credential: true };
  };
}

function tokenEdit(key: Buffer, change: ModelChange, token: string, at: string): (row: ModelConnectionRow) => ModelEdit {
  return (row) => {
    if (row.provider !== 'anthropic' || modelDetailOf(row.detail).subscription !== true) throw bad('Only a Claude subscription connection takes a Claude token.');
    return { change: { ...change, secret: sealModelSecret(key, row, { kind: 'claude', token }), detail: modelDetailText(subscriptionDetail(at)) }, credential: true };
  };
}

async function checkedTokenEdit(deps: ModelsDeps, raw: unknown, change: ModelChange): Promise<(row: ModelConnectionRow) => ModelEdit> {
  const key = modelKey(deps);
  const token = claudeTokenOf(raw);
  await checkClaudeToken(token, deps.fetch);
  return tokenEdit(key, change, token, isoNow(deps));
}

async function credentialEdit(deps: ModelsDeps, input: Record<string, unknown>, change: ModelChange): Promise<(row: ModelConnectionRow) => ModelEdit> {
  if (Object.hasOwn(input, 'apiKey') && Object.hasOwn(input, 'claudeToken')) throw bad('Send an API key or a Claude subscription token, not both.');
  if (Object.hasOwn(input, 'claudeToken')) return checkedTokenEdit(deps, input.claudeToken, change);
  if (Object.hasOwn(input, 'apiKey')) return keyEdit(modelKey(deps), change, apiKeyOf(input.apiKey));
  return () => ({ change });
}

export async function patchModel(deps: ModelsDeps, caller: Caller, id: string, body: unknown): Promise<{ connection: ConnectionView }> {
  const input = isRecord(body) ? body : {};
  const fields = Object.keys(input);
  if (fields.length === 0 || fields.some((field) => !PATCH_FIELDS.includes(field))) throw bad(`Send ${PATCH_FIELDS.join(', ')} to change.`);
  const edit = await credentialEdit(deps, input, plainChange(input));
  const saved = await deps.store.edit(caller.owner, id, isoNow(deps), edit);
  log.info({ owner: caller.owner, id, fields }, 'models: connection changed');
  return { connection: connectionView(saved) };
}

export async function deleteModel(deps: ModelsDeps, caller: Caller, id: string): Promise<{ id: string; deleted: true }> {
  const gone = await deps.store.remove(caller.owner, id);
  log.info({ owner: caller.owner, id: gone.id }, 'models: connection removed');
  return { id: gone.id, deleted: true };
}

function agentOf(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const agent = parseId(raw);
  if (agent === null) throw bad('agent must be an agent id, or null for the organization default');
  return agent;
}

export async function putRoute(deps: ModelsDeps, caller: Caller, body: unknown): Promise<{ agent: string | null; route: ModelRoute }> {
  const input = isRecord(body) ? body : {};
  const agent = agentOf(input.agent);
  const route = await deps.store.setRoute({ owner: caller.owner, agent, route: routeInput(input), actor: userActor(caller), at: isoNow(deps) });
  log.info({ owner: caller.owner, agent, primary: route.primary.connection, fallbacks: route.fallbacks.length }, 'models: route changed');
  return { agent, route };
}

export async function deleteRoute(deps: ModelsDeps, caller: Caller, query: URLSearchParams): Promise<{ agent: string | null; deleted: boolean }> {
  const agent = agentOf(query.get('agent') ?? undefined);
  const deleted = await deps.store.removeRoute(caller.owner, agent);
  if (deleted) log.info({ owner: caller.owner, agent }, 'models: route removed');
  return { agent, deleted };
}
