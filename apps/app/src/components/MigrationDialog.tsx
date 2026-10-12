import { useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import type { ConnectorMigration, MigrationSelection } from '@metro-labs/client/api/connector-migration-flow';
import { MIGRATION_CHANGED } from '@metro-labs/client/api/connector-migration-identity';
import type { MigrationAction } from '@metro-labs/client/api/connector-migration-status';
import { MIGRATION_PREVIEW_QUERY } from '../lib/migration-preview-query.js';
import { boxKey, queryError, useBoxQuery, type BoxKey } from '../lib/queries.js';
import { logError } from '../lib/log.js';
import { Loading } from './Loading.js';
import { MigrationProgress } from './MigrationProgress.js';
import { Modal } from './Modal.js';
import { TextLink } from './TextLink.js';
import { inNewTab } from './sign-in-tab.js';

function useMigrationActions(session: ConnectorMigration, key: BoxKey) {
  const client = useQueryClient();
  const queryKey = boxKey(key);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const current = (): boolean => {
    try { session.check(); return true; } catch { return false; }
  };
  const publish = (): void => {
    if (current()) client.setQueryData(queryKey, session.snapshot());
  };
  const perform = (job: () => Promise<unknown>, success: string | null): void => {
    if (pending.current || !current()) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setNote(null);
    setLink(null);
    job().then(() => {
      if (!current()) return;
      publish();
      setNote(success);
    }).catch((err: unknown) => {
      if (!current()) return;
      publish();
      setError(queryError(err, 'The migration outcome is uncertain. Refresh and Reconcile before continuing.'));
    }).finally(() => { pending.current = false; if (current()) setBusy(false); });
  };
  const act = (sourceId: string, action: MigrationAction, selection: MigrationSelection, oauthResource?: string): void => { perform(() => session.act(sourceId, action, selection, oauthResource), null); };
  const signIn = (sourceId: string, selection: MigrationSelection): void => {
    perform(() => inNewTab(() => session.signIn(sourceId, selection), (url) => url, (url) => { if (current()) setLink(url); }), 'Finish sign-in in the opened page, then choose Reconcile here. Opening sign-in is not proof of readiness.');
  };
  return { busy, error, link, note, act, signIn };
}

const readError = (error: Error | null): string | null => error === null ? null : queryError(error, 'Could not refresh migration status.');

export function MigrationDialog({ session, invalidated, onClose }: { session: ConnectorMigration; invalidated: boolean; onClose: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const key = ['connectors', 'migration', session.id] as const;
  const query = useBoxQuery(key, session.refresh, { ...MIGRATION_PREVIEW_QUERY, enabled: !invalidated, refetchOnReconnect: false, refetchOnMount: false });
  const actions = useMigrationActions(session, key);
  const busy = actions.busy || query.isFetching;
  const reload = (): void => {
    if (busy || invalidated) return;
    query.refetch().catch(logError('migration-refresh'));
  };
  const errors = [readError(query.error), query.data?.previewError, query.data?.statusError, actions.error].filter((value): value is string => typeof value === 'string');
  return <Modal title="Move to organization" open onClose={onClose}>
    <Col gap={16}>
      {invalidated ? <Text size="2xs" role="danger">{MIGRATION_CHANGED}</Text> : <>
        <Text size="2xs" role="secondary">Prepare, verify, then switch each connector separately. Nothing is retried automatically. Closing this dialog does not undo or reliably cancel a request. Reopen it and Refresh to check progress.</Text>
        {busy ? <Loading /> : null}
        {[...new Set(errors)].map((error) => <Text key={error} size="2xs" role="danger">{error}</Text>)}
        {actions.note === null ? null : <Text size="2xs" role="secondary">{actions.note}</Text>}
        {actions.link === null ? null : <TextLink url={actions.link}>Open central sign-in</TextLink>}
        {query.data === undefined ? null : <MigrationProgress snapshot={query.data} busy={busy} act={actions.act} signIn={actions.signIn} />}
      </>}
      <Row gap={8} justify="between" wrap>
        <Button color="secondary" dark={dark} label="Close" onPress={onClose} />
        {invalidated ? null : <Button color="secondary" dark={dark} label="Refresh" disabled={busy} onPress={reload} />}
      </Row>
    </Col>
  </Modal>;
}
