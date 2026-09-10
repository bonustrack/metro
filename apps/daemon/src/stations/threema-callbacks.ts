import { readJson } from '@metro-labs/core/secure-fs';
import { accountFilePath } from './materialize.js';

export interface ThreemaCallback {
  id: string;
  callbackId: string;
  callbackToken: string;
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : undefined;

function toCallback(row: unknown): ThreemaCallback | null {
  if (typeof row !== 'object' || row === null) return null;
  const rec = row as Record<string, unknown>;
  const id = str(rec.id);
  const callbackId = str(rec.callbackId);
  const callbackToken = str(rec.callbackToken);
  if (id === undefined || callbackId === undefined || callbackToken === undefined) return null;
  return { id, callbackId, callbackToken };
}

export function listThreemaCallbacks(): ThreemaCallback[] {
  const raw = readJson<unknown[]>(accountFilePath('threema'), [], {
    warn: 'threema-accounts.json: malformed, ignoring',
  });
  if (!Array.isArray(raw)) return [];
  return raw.map(toCallback).filter((c): c is ThreemaCallback => c !== null);
}

export const findThreemaCallback = (callbackId: string): ThreemaCallback | undefined =>
  listThreemaCallbacks().find((c) => c.callbackId === callbackId);
