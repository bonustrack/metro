import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { deleteOrgConnector, renameOrgConnector, replaceOrgConnectorKey, type OrgConnector } from '@metro-labs/client/api/org-connectors';
import { whenLabel } from '@metro-labs/client/api/when';
import { connectorLabel } from '@metro-labs/client/api/connectors';
import { ConfirmDialog, useConfirm } from './DeleteMenu.js';
import { FactRow, SettingsGroup, SettingsSection } from './SettingsSection.js';
import { FormField } from './FormField.js';
import { Modal } from './Modal.js';
import { NameModal } from './NameModal.js';
import { queryError } from '../lib/queries.js';
import { go } from '../lib/nav.js';

function authLabel(connector: OrgConnector): string {
  if (connector.auth === 'oauth') return 'Sign-in with the service';
  return connector.auth === 'header' ? `Key in the ${connector.header ?? 'Authorization'} header` : 'None';
}

export function OrgConnectorFacts({ connector }: { connector: OrgConnector }): ReactNode {
  return (
    <SettingsGroup title="Connection">
      <FactRow label="Instance ID" value={connector.id} />
      <FactRow label="Server (origin only)" value={connector.url} />
      <FactRow label="Sign-in" value={authLabel(connector)} />
      {connector.server === null ? null : <FactRow label="Service" value={connector.server} />}
      {connector.verifiedAt === null ? null : <FactRow label="Last checked" value={whenLabel(connector.verifiedAt)} />}
      {connector.clientId === null ? null : <FactRow label="App id" value={connector.clientId} />}
    </SettingsGroup>
  );
}

function KeyModal({ connector, open, onClose, onSaved }: { connector: OrgConnector; open: boolean; onClose: () => void; onSaved: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [header, setHeader] = useState(connector.header ?? '');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = (): void => {
    if (busy || value.trim() === '') return;
    setBusy(true);
    setError(null);
    replaceOrgConnectorKey(connector.id, header, value)
      .then(() => {
        setValue('');
        onSaved();
        onClose();
      })
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not save the key.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <Modal title="Replace the key" open={open} onClose={onClose}>
      <Col gap={12}>
        <Text size="md" role="secondary">Metro checks the new key with the server before it keeps it.</Text>
        <FormField label="Header (optional)" name="org-connector-header" value={header} placeholder="Authorization" dark={dark} disabled={busy} onChangeText={setHeader} />
        <FormField label="Value" name="org-connector-value" value={value} placeholder="Bearer sk-…" inputType="password" dark={dark} disabled={busy} onChangeText={setValue} onSubmit={save} />
        {error === null ? null : <Text size="md" role="danger">{error}</Text>}
        <Row justify="end">
          <Button size="lg" color="primary" dark={dark} label="Save" loading={busy} disabled={busy || value.trim() === ''} onPress={save} />
        </Row>
      </Col>
    </Modal>
  );
}

export function OrgConnectorManage({ connector, onChanged }: { connector: OrgConnector; onChanged: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [renaming, setRenaming] = useState(false);
  const [keying, setKeying] = useState(false);
  const removing = useConfirm(async () => { await deleteOrgConnector(connector.id); onChanged(); }, 'Could not remove the connector.', () => {
    go({ kind: 'org-connectors' });
  });
  return (
    <SettingsGroup title="Manage">
      <SettingsSection title="Name" note="A display name for this connector. Its instance ID stays the same when renamed.">
        <Button size="md" color="secondary" dark={dark} label="Rename" onPress={() => { setRenaming(true); }} />
      </SettingsSection>
      {connector.auth === 'oauth' ? null : (
        <SettingsSection title="Key" note="Replace the key the agents will use for this server.">
          <Button size="md" color="secondary" dark={dark} label="Replace key" onPress={() => { setKeying(true); }} />
        </SettingsSection>
      )}
      <SettingsSection title="Remove connector" note="Removes it and its secret, and takes it from every agent.">
        <Button size="md" color="danger" dark={dark} label="Remove" onPress={removing.show} />
      </SettingsSection>
      <ConfirmDialog confirming={removing} title="Remove this connector?" lines={[`“${connectorLabel(connector)}” and its secret are removed, and every agent loses it.`]} action="Remove connector" />
      <NameModal key={connector.name} title="Rename connector" action="Rename" placeholder={connector.name} initial={connector.name} failure="Could not rename the connector." open={renaming} onClose={() => { setRenaming(false); }} onSubmit={async (name) => { const row = await renameOrgConnector(connector.id, name); onChanged(); return row; }} />
      {keying ? <KeyModal key={connector.id} connector={connector} open onClose={() => { setKeying(false); }} onSaved={onChanged} /> : null}
    </SettingsGroup>
  );
}
