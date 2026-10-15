import { parseId } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import type { ModelChange, ModelConnectionRow, ModelEdit } from '@metro-labs/connectors/db/models';
import { MODEL_ID_MAX, type ModelRoute } from '@metro-labs/connectors/model-route';
import { isModelProvider, KEY_PROVIDERS, modelDetailOf, modelDetailText, sealModelSecret, type ModelProvider } from '@metro-labs/connectors/model-secret';
import { isoNow, modelKey, MODELS_MAX, userActor, type Caller, type ModelsDeps } from './deps.js';
import { apiKeyOf, creator, flagOf, LABEL_MAX, labelFor, newModelRow, regionOf, routeInput, textField } from './input.js';
import { connectionView, type ConnectionView, type ModelsView } from './view.js';

const PATCH_FIELDS = ['label', 'model', 'region', 'zdr', 'apiKey'];

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

export async function createModel(deps: ModelsDeps, caller: Caller, body: unknown): Promise<{ connection: ConnectionView }> {
  const key = modelKey(deps);
  const input = isRecord(body) ? body : {};
  const provider = keyProvider(input.provider);
  const apiKey = apiKeyOf(input.apiKey);
  const label = textField(input, 'label', 'label', LABEL_MAX) ?? '';
  const model = textField(input, 'model', 'model', MODEL_ID_MAX) ?? '';
  const region = regionOf(input.region);
  const zdr = flagOf(input.zdr, 'zero data retention');
  const taken = await roomFor(deps, caller.owner);
  const row = { ...newModelRow(creator(caller), provider, labelFor(taken, provider, label), isoNow(deps)), model, region, zdr };
  const made: ModelConnectionRow = { ...row, secret: sealModelSecret(key, row, { kind: 'key', apiKey }) };
  await deps.store.create(made);
  log.info({ owner: caller.owner, id: made.id, provider }, 'models: connection added');
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
    delete detail.signedOut;
    return { change: { ...change, secret: sealModelSecret(key, row, { kind: 'key', apiKey }), detail: modelDetailText(detail) }, credential: true };
  };
}

export async function patchModel(deps: ModelsDeps, caller: Caller, id: string, body: unknown): Promise<{ connection: ConnectionView }> {
  const input = isRecord(body) ? body : {};
  const fields = Object.keys(input);
  if (fields.length === 0 || fields.some((field) => !PATCH_FIELDS.includes(field))) throw bad(`Send ${PATCH_FIELDS.join(', ')} to change.`);
  const change = plainChange(input);
  const apiKey = Object.hasOwn(input, 'apiKey') ? apiKeyOf(input.apiKey) : null;
  const edit = apiKey === null ? (): ModelEdit => ({ change }) : keyEdit(modelKey(deps), change, apiKey);
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
  const route = await deps.store.setRoute({ owner: caller.owner, agent, route: routeInput(input, agent !== null), actor: userActor(caller), at: isoNow(deps) });
  log.info({ owner: caller.owner, agent, primary: route.primary.connection, fallbacks: route.fallbacks.length }, 'models: route changed');
  return { agent, route };
}

export async function deleteRoute(deps: ModelsDeps, caller: Caller, query: URLSearchParams): Promise<{ agent: string | null; deleted: boolean }> {
  const agent = agentOf(query.get('agent') ?? undefined);
  const deleted = await deps.store.removeRoute(caller.owner, agent);
  if (deleted) log.info({ owner: caller.owner, agent }, 'models: route removed');
  return { agent, deleted };
}
