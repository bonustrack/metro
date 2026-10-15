import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import type { ModelConnectionRow } from '@metro-labs/connectors/db/models';
import { modelDetailText, openModelSecret, sealModelSecret, type CodexSecret, type ModelDetail } from '@metro-labs/connectors/model-secret';
import { isoNow, modelKey, type Caller, type ModelsDeps } from './deps.js';
import { creator, labelFor, newModelRow } from './input.js';
import { roomFor } from './manage.js';
import { connectionView, type ConnectionView } from './view.js';

export const OTHER_ACCOUNT = 'this is another ChatGPT account than the one this connection signed in with; add a new connection for it';

export const noSuchCodex = (): ApiError => new ApiError('no such Codex connection', 404);

export async function codexRow(deps: ModelsDeps, owner: string, id: string): Promise<ModelConnectionRow> {
  const row = await deps.store.find(owner, id);
  if (row?.provider !== 'codex') throw noSuchCodex();
  return row;
}

function heldSubject(key: Buffer, row: ModelConnectionRow): string | undefined {
  try {
    const held = openModelSecret(key, row);
    return held?.kind === 'codex' && held.method === 'chatgpt' ? held.subject : undefined;
  } catch {
    return undefined;
  }
}

export async function saveCodex(deps: ModelsDeps, caller: Caller, connection: string | null, secret: CodexSecret, signedIn: ModelDetail): Promise<{ connection: ConnectionView }> {
  const key = modelKey(deps);
  const at = isoNow(deps);
  const detail = modelDetailText({ ...signedIn, signedInAt: at });
  if (connection === null) {
    const taken = await roomFor(deps, caller.owner);
    const row = newModelRow(creator(caller), 'codex', labelFor(taken, 'codex', ''), at);
    const made: ModelConnectionRow = { ...row, secret: sealModelSecret(key, row, secret), detail };
    await deps.store.create(made);
    log.info({ owner: caller.owner, id: made.id, method: secret.method }, 'models: Codex connected');
    return { connection: connectionView(made) };
  }
  const saved = await deps.store.edit(caller.owner, connection, at, (row) => {
    if (row.provider !== 'codex') throw noSuchCodex();
    const subject = heldSubject(key, row);
    if (secret.method === 'chatgpt' && subject !== undefined && subject !== secret.subject) throw new ApiError(OTHER_ACCOUNT, 409);
    return { change: { secret: sealModelSecret(key, row, secret), detail }, credential: true };
  });
  log.info({ owner: caller.owner, id: saved.id, method: secret.method }, 'models: Codex signed in again');
  return { connection: connectionView(saved) };
}
