import { log } from '@metro-labs/core/log';
import { TrainError } from '@metro-labs/core/train-error';
import { supportsHistoryDeletion } from './app-state.js';
import { createHistory, type History } from './history.js';

const UNAVAILABLE = 'WhatsApp local history is unavailable because this runtime lacks the deletion patch. Ask the owner to update and restart Metro to load the patched runtime. Prior history was invalidated to avoid stale deleted messages.';
const ignore = (): void => undefined;

export function createClientHistory(accountId: string, supported = supportsHistoryDeletion()): History {
  const history = createHistory(accountId);
  if (supported) return history;
  try {
    history.invalidate();
  } finally {
    history.close();
  }
  log.warn({ accountId }, UNAVAILABLE);
  return {
    read() { throw new TrainError('whatsapp_history_unavailable', UNAVAILABLE); },
    ingest: ignore,
    ingestSent: ignore,
    alias: ignore,
    clearRange: ignore,
    invalidate: ignore,
    update: ignore,
    deleteMessages: ignore,
    edit: ignore,
    flush: ignore,
    close: ignore,
  };
}
