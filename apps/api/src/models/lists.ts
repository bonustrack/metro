import { ApiError } from '@metro-labs/http/api-error';
import type { ModelConnectionRow } from '@metro-labs/connectors/db/models';
import { codexStale, refreshModelConnection } from '@metro-labs/connectors/model-refresh';
import { modelDetailOf, openModelSecret, type CodexSecret } from '@metro-labs/connectors/model-secret';
import { modelKey, refreshDeps, type Caller, type ModelsDeps } from './deps.js';
import { learnCodexVersion } from './codex-version.js';
import { fingerprint, type ListedModel } from './list-cache.js';
import { anthropicModels, bedrockModels, codexModels, KNOWN_CLAUDE, openrouterModels } from './provider-lists.js';

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

function keyOf(key: Buffer, row: ModelConnectionRow): string | null {
  const secret = openModelSecret(key, row);
  return secret?.kind === 'key' ? secret.apiKey : null;
}

async function keyedList(deps: ModelsDeps, key: Buffer, row: ModelConnectionRow): Promise<ListedModel[]> {
  const apiKey = keyOf(key, row);
  if (row.provider === 'anthropic') return apiKey === null ? KNOWN_CLAUDE : deps.lists.get(`anthropic:${row.id}:${fingerprint(apiKey)}`, () => anthropicModels(apiKey, deps.fetch));
  if (apiKey === null || row.region === '') throw new ApiError('Bedrock needs an API key and a region before its models can be listed.', 400);
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
