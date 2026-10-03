import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { Modal } from '@stage-labs/kit/react-native/modal';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { activeAccount } from '../auth/account.js';
import { baseFromSegment, daemonBase } from '../auth/daemon.js';
import { queryError, resetDestinationConnectors, useOrganizationsQuery } from '../api/queries.js';
import { copyConnectors, type CopyTarget, type CopyResult } from '../api/connector-copy.js';
import type { Connector, ConnectorsView } from '../api/connectors.js';
import type { OrganizationRow } from '../api/auth.js';
import { ConfirmModal } from './ConfirmModal.js';
import { Loading } from './Loading.js';

function CopyReport({ results, connectors }: { results: CopyResult[]; connectors: Connector[] }): ReactNode {
  const names = new Map(connectors.map((row) => [row.id, row.name]));
  const copied = results.filter((row) => row.status === 'copied').length;
  return <Col gap={8}>
    <Text size="2xs">{`${String(copied)} copied. Source settings were not changed by this copy.`}</Text>
    {results.map((row, index) => <Text key={`${row.sourceId ?? ''}:${String(index)}`} size="2xs" role={row.status === 'invalid' ? 'danger' : 'secondary'}>
      {`${names.get(row.sourceId ?? '') ?? 'Connector'}: ${row.status === 'skipped' ? 'skipped, that name already exists on the destination' : row.status === 'invalid' ? 'not copied, invalid settings' : 'copied'}`}
    </Text>)}
    <Text size="2xs" role="secondary">Reload plugins on the destination to make new connector tools available. Some services rotate login tokens, so either agent may need to reconnect for independent logins.</Text>
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
        <Text size="2xs" role="secondary">Choose an agent. Copy includes saved logins, client secrets, tool permissions and settings. You must administer both organizations.</Text>
        {props.pending ? <Loading /> : null}
        {props.error === null ? null : <Text size="2xs" role="danger">{queryError(props.error, 'Could not load agents.')}</Text>}
        {props.targets.map((row) => <Button key={`${row.organization}:${row.id}`} color="secondary" dark={dark} label={`${row.name} (${row.organizationName})`} onPress={() => { props.onSelect(row); }} />)}
        {!props.pending && props.targets.length === 0 ? <Text size="2xs" role="secondary">No other agent is available in an organization you administer.</Text> : null}
      </> : <CopyReport results={props.results} connectors={props.connectors} />}
      <Button color="secondary" dark={dark} label={props.results === null ? 'Cancel' : 'Done'} onPress={props.onClose} />
    </Col>
  </Modal>;
}

function CopyConfirmation({ title, state, onClose }: { title: string; state: ReturnType<typeof useCopy>; onClose: () => void }): ReactNode {
  if (state.target === null) return null;
  const target = state.target;
  return <ConfirmModal open={state.results === null} title={`${title} to ${target.name}?`}
    lines={[`Saved logins and client secrets will be copied to ${target.name} in ${target.organizationName}. Members of that organization will be able to use them.`, 'Some services rotate login tokens. A copied login can sign the source or destination out. Reconnect each agent separately to keep independent logins.', 'Source settings are not changed by this copy. Existing destination connectors with the same name are skipped, never overwritten.']}
    confirmWord="copy" confirmLabel="Copy with saved logins" busy={state.busy} error={state.error} onClose={onClose} onConfirm={state.run} />;
}

export function CopyConnectors({ connectors, all = false, onClose }: { connectors: Connector[]; all?: boolean; onClose: () => void }): ReactNode {
  const organizations = useOrganizationsQuery();
  const state = useCopy(connectors, all);
  const targets = copyTargets(organizations.data ?? [], new URL(daemonBase()).origin);
  const close = (): void => { if (!state.busy) onClose(); };
  const title = all ? 'Copy all connectors' : `Copy ${connectors[0]?.name ?? 'connector'}`;
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
