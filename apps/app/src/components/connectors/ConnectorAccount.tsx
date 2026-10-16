import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Pressable } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { deleteOrgConnector, replaceOrgConnectorKey, signInOrgConnector, type OrgConnector } from '@metro-labs/client/api/org-connectors';
import { whenLabel } from '@metro-labs/client/api/when';
import { ConfirmDialog, useConfirm } from '../DeleteMenu.js';
import { FormField } from '../FormField.js';
import { Modal } from '../Modal.js';
import { PublicOAuthResource } from '../PublicOAuthResource.js';
import { TextLink } from '../TextLink.js';
import { inNewTab } from '../sign-in-tab.js';
import { Group } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { orgConnectorStatus } from '../org-connector-status.js';
import { queryError } from '../../lib/queries.js';
import { refreshOrgConnectors } from '../../lib/org-connector-queries.js';
import { go } from '../../lib/nav.js';

function SignInModal({ connector, onClose }: { connector: OrgConnector; onClose: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [advanced, setAdvanced] = useState(false);
  const [resource, setResource] = useState('');
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const start = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setLink(null);
    inNewTab(() => signInOrgConnector(connector.id, undefined, undefined, resource), (url) => url, setLink)
      .catch((err: unknown) => { setError(queryError(err, 'Could not start the sign-in.')); })
      .finally(() => { setBusy(false); });
  };
  return (
    <Modal title={`Sign in to ${connector.name}`} open onClose={onClose}>
      <Col gap={16}>
        <Text size="md" role="secondary">{`A new tab opens at ${connector.name}. Sign in with the account every agent should use. This page updates when you come back.`}</Text>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: advanced }} onPress={() => { setAdvanced(!advanced); }}>
          <Text size="md" role="link">{advanced ? 'Hide advanced' : 'Advanced'}</Text>
        </Pressable>
        {advanced ? <PublicOAuthResource value={resource} disabled={busy} onChange={setResource} /> : null}
        {link === null ? null : <TextLink url={link}>Open the sign-in</TextLink>}
        {error === null ? null : <Text size="md" role="danger">{error}</Text>}
        <Row justify="end">
          <Button size="lg" color="primary" dark={dark} label="Sign in" loading={busy} disabled={busy} onPress={start} />
        </Row>
      </Col>
    </Modal>
  );
}

function KeyModal({ connector, onClose }: { connector: OrgConnector; onClose: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const client = useQueryClient();
  const [header, setHeader] = useState(connector.header ?? '');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = (): void => {
    if (busy || value.trim() === '') return;
    setBusy(true);
    setError(null);
    replaceOrgConnectorKey(connector.id, header, value)
      .then(() => refreshOrgConnectors(client))
      .then(onClose)
      .catch((err: unknown) => { setError(queryError(err, 'Could not save the key.')); })
      .finally(() => { setBusy(false); });
  };
  return (
    <Modal title="Replace the key" open onClose={onClose}>
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

type Open = 'sign-in' | 'key' | null;

export function ConnectorAccount({ connector }: { connector: OrgConnector }): ReactNode {
  const client = useQueryClient();
  const [open, setOpen] = useState<Open>(null);
  const status = orgConnectorStatus(connector);
  const removing = useConfirm(async () => {
    await deleteOrgConnector(connector.id);
    await refreshOrgConnectors(client);
  }, 'Could not remove the connector.', () => { go({ kind: 'org-connectors' }); });
  return (
    <Group label="Account">
      {connector.auth === 'oauth' ? (
        <Item title={status.bad ? 'Sign in' : 'Sign in again'} subtitle={status.bad ? 'Agents cannot use it until someone signs in' : 'Another account, or renew access'} onPress={() => { setOpen('sign-in'); }} />
      ) : null}
      {connector.auth === 'header' ? <Item title="Replace the key" subtitle="The key agents use for this server" onPress={() => { setOpen('key'); }} /> : null}
      <Item title={`Remove ${connector.name}`} subtitle="Every agent loses it at once" danger chevron={false} onPress={removing.show} />
      {open === 'sign-in' ? <SignInModal connector={connector} onClose={() => { setOpen(null); }} /> : null}
      {open === 'key' ? <KeyModal connector={connector} onClose={() => { setOpen(null); }} /> : null}
      <ConfirmDialog confirming={removing} title="Remove this connector?" lines={[`“${connector.name}” and its secret are removed, and every agent loses it.`]} action="Remove connector" />
    </Group>
  );
}

function authLabel(connector: OrgConnector): string {
  if (connector.auth === 'oauth') return 'Sign-in with the service';
  return connector.auth === 'header' ? `Key in the ${connector.header ?? 'Authorization'} header` : 'None';
}

export function ConnectorFacts({ connector }: { connector: OrgConnector }): ReactNode {
  const facts: [string, string | null][] = [
    ['Instance ID', connector.id],
    ['Server', connector.url],
    ['Sign-in', authLabel(connector)],
    ['Service', connector.server],
    ['Last checked', connector.verifiedAt === null ? null : whenLabel(connector.verifiedAt)],
    ['App id', connector.clientId],
  ];
  return (
    <Group label="Technical details">
      {facts.flatMap(([label, value]) => (value === null ? [] : [<Item key={label} title={label} subtitle={value} />]))}
    </Group>
  );
}
