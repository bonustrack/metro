import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeSecure } from '@metro-labs/mcp/secure-fs';
import { errMsg } from '@metro-labs/mcp/log';

export const PERSISTED_KEY_TYPES = ['tctoken', 'lid-mapping'] as const;

export type KeyTable = Record<string, Record<string, unknown>>;

const PERSISTED = new Set<string>(PERSISTED_KEY_TYPES);

const WRITE_DEBOUNCE_MS = 1000;

export const isPersistedKeyType = (type: string): boolean =>
  PERSISTED.has(type);

const safeSegment = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, '_');

export function tokenStorePath(accountId: string): string {
  const dir = process.env.WHATSAPP_TOKEN_DIR ?? join(homedir(), '.metro');
  return join(dir, `whatsapp-tokens-${safeSegment(accountId)}.json`);
}

export function persistedSubset(table: KeyTable): KeyTable {
  const out: KeyTable = {};
  for (const type of PERSISTED_KEY_TYPES) {
    const bucket = table[type];
    if (!bucket) continue;
    const kept: Record<string, unknown> = {};
    for (const id of Object.keys(bucket)) {
      const value = bucket[id];
      if (value === undefined || value === null) continue;
      kept[id] = value;
    }
    if (Object.keys(kept).length) out[type] = kept;
  }
  return out;
}

export interface TokenStore {
  path: string;
  load(): KeyTable;
  scheduleSave(table: KeyTable): void;
  saveNow(table: KeyTable): void;
}

export function makeTokenStore(
  accountId: string,
  onError: (message: string) => void,
): TokenStore {
  const path = tokenStorePath(accountId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: KeyTable | undefined;
  let written = '';
  const saveNow = (table: KeyTable): void => {
    const body = JSON.stringify(persistedSubset(table));
    if (body === written) return;
    try {
      writeSecure(path, body);
      written = body;
    } catch (err) {
      onError(`could not write ${path}: ${errMsg(err)}`);
    }
  };
  return {
    path,
    load() {
      const table = persistedSubset(readJson<KeyTable>(path, {}));
      written = JSON.stringify(table);
      return table;
    },
    scheduleSave(table) {
      pending = table;
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (pending) saveNow(pending);
        pending = undefined;
      }, WRITE_DEBOUNCE_MS);
      timer.unref?.();
    },
    saveNow,
  };
}

const stores = new Map<string, TokenStore>();

export function tokenStoreFor(
  accountId: string,
  onError: (message: string) => void,
): TokenStore {
  const path = tokenStorePath(accountId);
  const existing = stores.get(path);
  if (existing) return existing;
  const store = makeTokenStore(accountId, onError);
  stores.set(path, store);
  return store;
}
