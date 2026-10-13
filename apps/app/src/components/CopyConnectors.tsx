import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { Modal } from './Modal.js';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { activeAccount } from '@metro-labs/client/auth/account';
import { baseFromSegment, daemonBase } from '@metro-labs/client/auth/daemon';
import { queryError, resetDestinationConnectors, useOrganizationsQuery } from '../lib/queries.js';
import { copyConnectors, type CopyTarget, type CopyResult } from '@metro-labs/client/api/connector-copy';
import { connectorLabel, type Connector, type ConnectorsView } from '@metro-labs/client/api/connectors';
import type { OrganizationRow } from '@metro-labs/client/api/auth';
import { ConfirmModal } from './ConfirmModal.js';
import { Loading } from './Loading.js';

function CopyReport({ results, connectors }: { results: CopyResult[]; connectors: Connector[] }): ReactNode {
  const names = new Map(connectors.map((row) => [row.id, connectorLabel(row, connectors)]));
  const copied = results.filter((row) => row.status === 'copied').length;
  return <Col gap={8}>
    <Text size="md">{`${String(copied)} copied. Source settings were not changed by this copy.`}</Text>
    {results.map((row, index) => <Text key={`${row.sourceId ?? ''}:${String(index)}`} size="md" role={row.status === 'invalid' ? 'danger' : 'secondary'}>
      {`${names.get(row.sourceId ?? '') ?? `Connector (${row.sourceId ?? 'unknown'})`}: ${row.status === 'skipped' ? 'skipped by the destination agent' : row.status === 'invalid' ? 'not copied, invalid settings' : `copied${row.id === undefined ? '' : ` as ${row.id}`}`}`}
    </Text>)}
    <Text size="md" role="secondary">Reload plugins on the other agent to see the new tools. Some services rotate logins, so either agent may need to sign in again.</Text>
  </Col>;
}

function copyTargets(rows: OrganizationRow[], source: string): CopyTarget[] {
  return rows.filter((org) => org.role === 'admin').flatMap((org) =>
    (org.agents ?? []).filter((agent) => baseFromSegment(agent.host) !== source).map((agent) => ({
      organization: org.id, organizationName: org.name ?? org.id, id: agent.id, host: agent.host, name: agent.name ?? agent.host,
    })),
  );
}

function useCopy(connectors: Connector[], all: boolean) {
  const client = useQueryClient();
  const [target, setTarget] = useState<CopyTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<CopyResult[] | null>(null);
  const run = (): void => {
    if (target === null || busy) return;
    setBusy(true);
    setError(null);
    copyConnectors(target, all ? null : connectors.map((row) => row.id), true).then(setResults).catch((err: unknown) => {
      setError(queryError(err, 'Could not copy connectors.'));
    }).finally(() => {
      resetDestinationConnectors(client, baseFromSegment(target.host));
      setBusy(false);
    });
  };
  return { target, setTarget, busy, error, results, run };
}

interface ChooserProps {
  title: string;
  open: boolean;
  pending: boolean;
  error: unknown;
  targets: CopyTarget[];
  results: CopyResult[] | null;
  connectors: Connector[];
  onSelect: (target: CopyTarget) => void;
  onClose: () => void;
}

function CopyChooser(props: ChooserProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  return <Modal title={props.title} open={props.open} onClose={props.onClose}>
    <Col gap={14}>
      {props.results === null ? <>
        <Text size="md" role="secondary">Choose an agent. Logins, secrets, permissions and settings are copied. You must be an admin of both organizations.</Text>
        {props.pending ? <Loading /> : null}
        {props.error === null ? null : <Text size="md" role="danger">{queryError(props.error, 'Could not load agents.')}</Text>}
        {props.targets.map((row) => <Button key={`${row.organization}:${row.id}`} color="secondary" dark={dark} label={`${row.name} (${row.organizationName})`} onPress={() => { props.onSelect(row); }} />)}
        {!props.pending && props.targets.length === 0 ? <Text size="md" role="secondary">No other agent in an organization where you are admin.</Text> : null}
      </> : <CopyReport results={props.results} connectors={props.connectors} />}
      <Button color="secondary" dark={dark} label={props.results === null ? 'Cancel' : 'Done'} onPress={props.onClose} />
    </Col>
  </Modal>;
}

function CopyConfirmation({ title, state, onClose }: { title: string; state: ReturnType<typeof useCopy>; onClose: () => void }): ReactNode {
  if (state.target === null) return null;
  const target = state.target;
  return <ConfirmModal open={state.results === null} title={`${title} to ${target.name}?`}
    lines={[`Logins and secrets are copied to ${target.name} in ${target.organizationName}, and its members can use them.`, 'Some services rotate logins, so a copy can sign one agent out. Sign each one in again to keep them apart.', 'Nothing changes here. Each copy is a new connector, and nothing there is overwritten.']}
    confirmWord="copy" confirmLabel="Copy with saved logins" busy={state.busy} error={state.error} onClose={onClose} onConfirm={state.run} />;
}

export function CopyConnectors({ connectors, all = false, onClose }: { connectors: Connector[]; all?: boolean; onClose: () => void }): ReactNode {
  const organizations = useOrganizationsQuery();
  const state = useCopy(connectors, all);
  const targets = copyTargets(organizations.data ?? [], new URL(daemonBase()).origin);
  const close = (): void => { if (!state.busy) onClose(); };
  const title = all ? 'Copy all connectors' : `Copy ${connectors[0] === undefined ? 'connector' : connectorLabel(connectors[0])}`;
  if (activeAccount()?.role !== 'admin') return null;
  return <>
    <CopyChooser title={title} open={state.target === null || state.results !== null} pending={organizations.isPending} error={organizations.error}
      targets={targets} results={state.results} connectors={connectors} onSelect={state.setTarget} onClose={close} />
    <CopyConfirmation title={title} state={state} onClose={close} />
  </>;
}

export function CopyAllConnectors({ data }: { data: ConnectorsView | undefined }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [open, setOpen] = useState(false);
  if (activeAccount()?.role !== 'admin' || data === undefined || data.connectors.length === 0) return null;
  return <>
    <Button color="secondary" dark={dark} label="Copy all" onPress={() => { setOpen(true); }} />
    {open ? <CopyConnectors connectors={data.connectors} all onClose={() => { setOpen(false); }} /> : null}
  </>;
}
