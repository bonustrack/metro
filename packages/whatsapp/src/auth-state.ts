import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
  type SignalKeyStore,
} from '@whiskeysockets/baileys';
import { TrainError } from '@metro-labs/mcp/train-error';

type KeyTable = Record<string, Record<string, unknown>>;

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

function makeKeyStore(table: KeyTable): SignalKeyStore {
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
      for (const category of Object.keys(data) as (keyof SignalDataSet)[]) {
        const items = data[category];
        if (!items) continue;
        const bucket = (table[category] ??= {});
        for (const id of Object.keys(items)) {
          const value = items[id];
          bucket[id] = value ? encode(value) : undefined;
        }
      }
    },
  };
}

export function inMemoryAuthState(raw?: unknown): {
  state: AuthenticationState;
  serialize: () => unknown;
} {
  const blob: AuthBlob =
    raw === undefined || raw === null
      ? { creds: initAuthCreds(), keys: {} }
      : loadBlob(raw);
  const state: AuthenticationState = {
    creds: blob.creds,
    keys: makeKeyStore(blob.keys),
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
  const { state } = inMemoryAuthState(credentials);
  return { state, saveCreds: () => Promise.resolve() };
}
