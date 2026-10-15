import { errMsg, log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import type { ModelConnectionRow } from '@metro-labs/connectors/db/models';
import { codexStale, refreshModelConnection } from '@metro-labs/connectors/model-refresh';
import { modelDetailOf, openModelSecret, type CodexSecret, type ModelSecret } from '@metro-labs/connectors/model-secret';
import { modelKey, refreshDeps, type Caller, type ModelsDeps } from './deps.js';
import { learnCodexVersion } from './codex-version.js';
import { fingerprint, type ListedModel } from './list-cache.js';
import { anthropicModels, bedrockModels, codexModels, KNOWN_CLAUDE, openrouterModels, subscriptionModels } from './provider-lists.js';

const SIGNED_OUT = 'This Codex connection is signed out. Sign in again on the Models page.';

async function freshCodex(deps: ModelsDeps, key: Buffer, row: ModelConnectionRow): Promise<CodexSecret> {
  const current = codexStale(key, row, deps.now()) ? await refreshModelConnection(refreshDeps(deps, key), row.owner, row.id) : row;
  const secret = modelDetailOf(current.detail).signedOut === true ? null : openModelSecret(key, current);
  if (secret?.kind !== 'codex') throw new ApiError(SIGNED_OUT, 400);
  return secret;
}

async function codexList(deps: ModelsDeps, key: Buffer, row: ModelConnectionRow): Promise<ListedModel[]> {
  const secret = await freshCodex(deps, key, row);
  const version = secret.method === 'code' ? await learnCodexVersion(deps.fetch, deps.now()) : '';
  const who = secret.method === 'code' ? (secret.accountId ?? '') : (secret.clientId ?? '');
  return deps.lists.get(`codex:${row.id}:${secret.method}:${fingerprint(who)}:${version}`, () => codexModels(secret, version, deps.fetch));
}

async function subscriptionList(deps: ModelsDeps, row: ModelConnectionRow, token: string): Promise<ListedModel[]> {
  try {
    return await deps.lists.get(`claude:${row.id}:${fingerprint(token)}`, () => subscriptionModels(token, deps.fetch));
  } catch (err) {
    log.warn({ owner: row.owner, connection: row.id, err: errMsg(err) }, 'models: Anthropic would not list the models of a Claude subscription, so the known Claude models are offered');
    return KNOWN_CLAUDE;
  }
}

async function anthropicList(deps: ModelsDeps, row: ModelConnectionRow, secret: ModelSecret | null): Promise<ListedModel[]> {
  if (secret?.kind === 'claude') return subscriptionList(deps, row, secret.token);
  if (secret?.kind !== 'key') return KNOWN_CLAUDE;
  const apiKey = secret.apiKey;
  return deps.lists.get(`anthropic:${row.id}:${fingerprint(apiKey)}`, () => anthropicModels(apiKey, deps.fetch));
}

async function keyedList(deps: ModelsDeps, key: Buffer, row: ModelConnectionRow): Promise<ListedModel[]> {
  const secret = openModelSecret(key, row);
  if (row.provider === 'anthropic') return anthropicList(deps, row, secret);
  if (secret?.kind !== 'key' || row.region === '') throw new ApiError('Bedrock needs an API key and a region before its models can be listed.', 400);
  const apiKey = secret.apiKey;
  return deps.lists.get(`bedrock:${row.id}:${fingerprint(apiKey, row.region)}`, () => bedrockModels(apiKey, row.region, deps.fetch));
}

export async function listConnectionModels(deps: ModelsDeps, caller: Caller, id: string): Promise<{ models: ListedModel[] }> {
  const key = modelKey(deps);
  const row = await deps.store.find(caller.owner, id);
  if (row === null) throw new ApiError('no such model connection', 404);
  if (row.provider === 'openrouter') return { models: await deps.lists.get('openrouter', () => openrouterModels(deps.fetch)) };
  if (row.provider === 'codex') return { models: await codexList(deps, key, row) };
  return { models: await keyedList(deps, key, row) };
}
