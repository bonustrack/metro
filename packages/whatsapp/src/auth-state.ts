import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
  type SignalKeyStore,
} from 'baileys';
import { TrainError } from '@metro-labs/mcp/train-error';
import {
  isPersistedKeyType,
  tokenStoreFor,
  type KeyTable,
} from './token-store.js';

interface AuthBlob {
  creds: AuthenticationCreds;
  keys: KeyTable;
}

function encode(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, BufferJSON.replacer));
}

function decode(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), BufferJSON.reviver);
}

function loadBlob(raw: unknown): AuthBlob {
  const obj = raw as { creds?: unknown; keys?: KeyTable } | null;
  const creds = obj?.creds;
  if (creds === undefined || creds === null)
    throw new TrainError(
      'whatsapp_auth',
      'stored credentials blob has no creds',
    );
  return {
    creds: decode(creds) as AuthenticationCreds,
    keys: obj?.keys ?? {},
  };
}

function makeKeyStore(
  table: KeyTable,
  onPersistedWrite?: (table: KeyTable) => void,
): SignalKeyStore {
  return {
    get: <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
      const bucket = table[type] ?? {};
      const data: Record<string, SignalDataTypeMap[T]> = {};
      for (const id of ids) {
        const raw = bucket[id];
        if (raw === undefined || raw === null) continue;
        const revived = decode(raw);
        data[id] = (
          type === 'app-state-sync-key'
            ? proto.Message.AppStateSyncKeyData.fromObject(
                revived as Record<string, unknown>,
              )
            : revived
        ) as SignalDataTypeMap[T];
      }
      return data;
    },
    set: (data: SignalDataSet) => {
      let persisted = false;
      for (const category of Object.keys(data) as (keyof SignalDataSet)[]) {
        const items = data[category];
        if (!items) continue;
        if (isPersistedKeyType(category)) persisted = true;
        const bucket = (table[category] ??= {});
        for (const id of Object.keys(items)) {
          const value = items[id];
          bucket[id] = value ? encode(value) : undefined;
        }
      }
      if (persisted) onPersistedWrite?.(table);
    },
  };
}

export function inMemoryAuthState(
  raw?: unknown,
  opts?: { seed?: KeyTable; onPersistedWrite?: (table: KeyTable) => void },
): {
  state: AuthenticationState;
  serialize: () => unknown;
} {
  const blob: AuthBlob =
    raw === undefined || raw === null
      ? { creds: initAuthCreds(), keys: {} }
      : loadBlob(raw);
  for (const [type, bucket] of Object.entries(opts?.seed ?? {}))
    blob.keys[type] = { ...blob.keys[type], ...bucket };
  const state: AuthenticationState = {
    creds: blob.creds,
    keys: makeKeyStore(blob.keys, opts?.onPersistedWrite),
  };
  return {
    state,
    serialize: () => ({ creds: encode(blob.creds), keys: blob.keys }),
  };
}

export function useAccountAuthState(
  credentials: unknown,
  accountId: string,
): {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
} {
  if (credentials === undefined || credentials === null)
    throw new TrainError(
      'whatsapp_auth',
      `no WhatsApp credentials in accounts for '${accountId}' — run scripts/login.ts to pair`,
    );
  const store = tokenStoreFor(accountId, (message) => {
    process.stderr.write(`whatsapp[${accountId}] token store: ${message}\n`);
  });
  const { state } = inMemoryAuthState(credentials, {
    seed: store.load(),
    onPersistedWrite: (table) => {
      store.scheduleSave(table);
    },
  });
  return { state, saveCreds: () => Promise.resolve() };
}
