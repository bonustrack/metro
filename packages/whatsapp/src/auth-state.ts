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
import {
  deleteWhatsappAuth,
  readWhatsappAuth,
  writeWhatsappAuth,
  type WhatsappAuthRef,
  type WhatsappAuthRow,
} from '@metro-labs/mcp/db/whatsapp-auth';

const CREDS_CATEGORY = 'creds';
const CREDS_ITEM = '';

function encode(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, BufferJSON.replacer));
}

function decode(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), BufferJSON.reviver);
}

async function getKeys<T extends keyof SignalDataTypeMap>(
  accountId: string,
  type: T,
  ids: string[],
): Promise<Record<string, SignalDataTypeMap[T]>> {
  const stored = await readWhatsappAuth(accountId, type, ids);
  const data: Record<string, SignalDataTypeMap[T]> = {};
  for (const id of ids) {
    const raw = stored.get(id);
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
}

async function setKeys(accountId: string, data: SignalDataSet): Promise<void> {
  const writes: WhatsappAuthRow[] = [];
  const deletes: WhatsappAuthRef[] = [];
  for (const category of Object.keys(data) as (keyof SignalDataSet)[]) {
    const items = data[category];
    if (!items) continue;
    for (const id of Object.keys(items)) {
      const value = items[id];
      if (value) writes.push({ category, itemId: id, value: encode(value) });
      else deletes.push({ category, itemId: id });
    }
  }
  await writeWhatsappAuth(accountId, writes);
  await deleteWhatsappAuth(accountId, deletes);
}

async function loadCreds(accountId: string): Promise<AuthenticationCreds> {
  const stored = (
    await readWhatsappAuth(accountId, CREDS_CATEGORY, [CREDS_ITEM])
  ).get(CREDS_ITEM);
  if (stored === undefined || stored === null) return initAuthCreds();
  return decode(stored) as AuthenticationCreds;
}

export async function usePostgresAuthState(accountId: string): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  const creds = await loadCreds(accountId);
  const keys: SignalKeyStore = {
    get: (type, ids) => getKeys(accountId, type, ids),
    set: (data) => setKeys(accountId, data),
  };
  const saveCreds = async (): Promise<void> => {
    await writeWhatsappAuth(accountId, [
      { category: CREDS_CATEGORY, itemId: CREDS_ITEM, value: encode(creds) },
    ]);
  };
  return { state: { creds, keys }, saveCreds };
}
