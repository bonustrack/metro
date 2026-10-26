import { type ReactNode, useRef, useState } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { ChoicePicker } from '@stage-labs/kit/react-native/choice-picker';
import { Text } from '@stage-labs/kit/react-native/text';
import type { OrganizationRow } from '@metro-labs/client/api/auth';
import { connectorCopyNameError, copyOrgConnector, type CopiedOrgConnector, type OrgConnector } from '@metro-labs/client/api/org-connectors';
import { activeAccount } from '@metro-labs/client/auth/account';
import { FieldLabel } from '../FieldLabel.js';
import { FormField } from '../FormField.js';
import { Modal, ModalText } from '../Modal.js';
import { Actions } from '../ui/Actions.js';
import { ErrorState } from '../ui/ErrorState.js';
import { Item } from '../ui/Item.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { StateBlock } from '../ui/StateBlock.js';
import { copiedConnectorHash, copyOrganizationName, copyTarget, copyTargets } from '../../lib/connector-copy.js';
import { queryError, useOrganizationsQuery } from '../../lib/queries.js';

const SHARING_NOTE = 'Copying shares saved private URLs, API keys and Bearer/header credentials with the destination, giving it access to the same upstream account; OAuth needs a new sign-in and agents are not copied.';

interface CopySuccess {
  result: CopiedOrgConnector;
  destination: OrganizationRow;
}

function Destination({ targets, value, disabled, onChange }: { targets: OrganizationRow[]; value: string; disabled: boolean; onChange: (value: string) => void }): ReactNode {
  const options = targets.map((row) => ({ value: row.id, label: copyOrganizationName(row) }));
  return (
    <Column gap={6}>
      <FieldLabel>Destination organization</FieldLabel>
      <ChoicePicker variant="mutuallyExclusive" options={options} value={value === '' ? [] : [value]} disabled={disabled} accessibility={{ label: 'Destination organization' }} onChange={(picked) => { onChange(picked[0] ?? ''); }} />
    </Column>
  );
}

interface DestinationStateProps {
  organizations: ReturnType<typeof useOrganizationsQuery>;
  targets: OrganizationRow[];
  target: OrganizationRow | undefined;
  busy: boolean;
  onChange: (value: string) => void;
}

function DestinationState({ organizations, targets, target, busy, onChange }: DestinationStateProps): ReactNode {
  if (organizations.error !== null) return <ErrorState title="Could not load organizations" text={queryError(organizations.error, 'Metro did not answer.')} onRetry={organizations.refetch} />;
  if (organizations.data === undefined) return <RowsSkeleton rows={2} />;
  if (targets.length === 0) return <StateBlock icon="officeBuilding" title="No destination organization" text="You need to be an admin of another organization to copy this connector." />;
  return <Destination targets={targets} value={target?.id ?? ''} disabled={busy} onChange={onChange} />;
}

function Success({ success, onClose }: { success: CopySuccess; onClose: () => void }): ReactNode {
  return (
    <Column gap={20}>
      <ModalText>{`${success.result.connector.name} was copied to ${copyOrganizationName(success.destination)}.`}</ModalText>
      <Text size="xs" color="secondary">You are still in the source organization; tool rules were kept, but agents, their overrides and activity history were not copied.</Text>
      {success.result.connector.auth === 'oauth' ? <Text size="xs" color="secondary">Sign in to the copied connector in the destination before using its tools.</Text> : null}
      <Item title="Open in destination" href={copiedConnectorHash(success.result, success.destination)} />
      <Actions cancel={{ label: 'Done', onPress: onClose }} />
    </Column>
  );
}

function useCopyTarget(targets: OrganizationRow[], loaded: boolean): [OrganizationRow | undefined, (value: string) => void] {
  const [organization, setOrganization] = useState<string | null>(null);
  const target = copyTarget(targets, organization ?? '');
  if (loaded && organization === null) setOrganization(targets.length === 1 ? targets[0]?.id ?? '' : '');
  else if (loaded && organization !== '' && target === undefined) setOrganization('');
  return [target, setOrganization];
}

export function CopyConnectorModal({ connector, onClose }: { connector: OrgConnector; onClose: () => void }): ReactNode {
  const organizations = useOrganizationsQuery();
  const targets = copyTargets(organizations.data ?? [], activeAccount()?.organization ?? null);
  const [target, setOrganization] = useCopyTarget(targets, organizations.data !== undefined);
  const [name, setName] = useState(connector.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<CopySuccess | null>(null);
  const state = useRef<'ready' | 'pending' | 'done'>('ready');
  const nameError = connectorCopyNameError(name);
  const ready = organizations.data !== undefined && organizations.error === null && target !== undefined && nameError === null;
  const close = (): void => { if (state.current !== 'pending') onClose(); };
  const submit = (): void => {
    if (state.current !== 'ready' || !ready || target === undefined) return;
    state.current = 'pending';
    setBusy(true);
    setError(null);
    copyOrgConnector(connector.id, { organization: target.id, name: name.trim(), shareCredentials: true })
      .then((result) => { state.current = 'done'; setSuccess({ result, destination: target }); })
      .catch((err: unknown) => { state.current = 'ready'; setError(queryError(err, 'Could not copy the connector.')); })
      .finally(() => { setBusy(false); });
  };
  return (
    <Modal title={success === null ? 'Copy connector' : 'Connector copied'} open onClose={close} dismissable={!busy}>
      {success === null ? (
        <Column gap={20}>
          <ModalText>{SHARING_NOTE}</ModalText>
          <DestinationState organizations={organizations} targets={targets} target={target} busy={busy} onChange={setOrganization} />
          <FormField label="Connector name" name="copy-connector-name" value={name} disabled={busy} onChangeText={setName} onSubmit={submit} />
          <Actions error={error ?? nameError} cancel={{ onPress: close, disabled: busy }} main={{ label: 'Copy', busy, disabled: !ready, onPress: submit }} />
        </Column>
      ) : <Success success={success} onClose={close} />}
    </Modal>
  );
}

export function CopyConnectorRow({ connector }: { connector: OrgConnector }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Item title="Copy to another organization..." subtitle="Create a separate connector and share its saved access." onPress={() => { setOpen(true); }} />
      {open ? <CopyConnectorModal connector={connector} onClose={() => { setOpen(false); }} /> : null}
    </>
  );
}
