import { currentServer } from '@metro-labs/client/auth/daemon';
import { namedConnector, type NamedConnector } from './approval-note.js';
import { useOrgConnectorsQuery } from './org-connector-queries.js';

export function useNamedConnector(key: string | null, known?: NamedConnector): NamedConnector | null | undefined {
  const read = useOrgConnectorsQuery(undefined, key !== null && known === undefined);
  if (known !== undefined) return known;
  if (key === null) return null;
  return namedConnector(key, currentServer()?.id ?? null, read);
}
