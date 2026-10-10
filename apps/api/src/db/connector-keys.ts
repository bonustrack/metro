import { eq } from 'drizzle-orm';
import type { ConnectorKeyStore } from '../connectors/keyring.js';
import type { Database } from './client.js';
import { connectorKeys } from './schema.js';

export function connectorKeyStore(db: () => Database): ConnectorKeyStore {
  return {
    find: async (owner) => {
      const rows = await db().select().from(connectorKeys).where(eq(connectorKeys.owner, owner)).limit(1);
      return rows[0] ?? null;
    },
    insert: async (row) => {
      await db().insert(connectorKeys).values(row).onConflictDoNothing({ target: connectorKeys.owner });
    },
  };
}
