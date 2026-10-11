import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createConnectorSync, type ConnectorSync } from '@metro-labs/client/api/connector-sync';
import type { Server } from '@metro-labs/client/api/servers';
import { boxKey, queryError, useBoxQuery, type BoxKey } from './queries.js';

export const CONNECTOR_SYNC_QUERY = {
  staleTime: 0,
  gcTime: 0,
  retry: false,
  refetchOnMount: 'always',
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const;

export function useConnectorSync(server: Server, scope: string) {
  const client = useQueryClient();
  const flow = useRef<ConnectorSync | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const key: BoxKey = ['connector-sync', scope];
  const session = (): ConnectorSync => { flow.current ??= createConnectorSync(server); return flow.current; };
  const query = useBoxQuery(key, () => session().read(), CONNECTOR_SYNC_QUERY);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; flow.current?.dispose(); flow.current = null; };
  }, []);
  const refresh = (): void => {
    if (pending.current || query.isFetching) return;
    setSaveError(null);
    query.refetch().catch(() => { if (mounted.current) setSaveError('Could not refresh connector sync status.'); });
  };
  const save = (enabled: boolean): void => {
    if (pending.current || query.isFetching || query.error !== null || saveError !== null) return;
    pending.current = true;
    setSaving(true);
    setSaveError(null);
    const capturedKey = boxKey(key);
    session().save(enabled).then((status) => {
      if (mounted.current) client.setQueryData(capturedKey, status);
    }).catch((error: unknown) => {
      if (mounted.current) setSaveError(queryError(error, 'Could not confirm connector sync. Refresh status before trying again.'));
    }).finally(() => {
      pending.current = false;
      if (mounted.current) setSaving(false);
    });
  };
  return {
    status: query.isFetching || saving || query.error !== null || saveError !== null ? undefined : query.data,
    busy: query.isFetching || saving,
    saving,
    error: saveError ?? (query.error === null ? null : queryError(query.error, 'Could not read connector sync status.')),
    refresh,
    save,
  };
}
