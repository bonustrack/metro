import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Switch } from '@stage-labs/kit/react-native/switch';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { activeAccount } from '@metro-labs/client/auth/account';
import { currentSyncStatus, syncReceiptLabel, type ConnectorSyncStatus } from '@metro-labs/client/api/connector-sync-status';
import { enrollmentRunning, enrollmentScopeIdentity, subscribeEnrollmentScope } from '@metro-labs/client/api/enrollment-scope';
import type { Server } from '@metro-labs/client/api/servers';
import { useConnectorScope } from '../lib/org-connector-queries.js';
import { useConnectorSync } from '../lib/connector-sync-query.js';
import { SettingsGroup, SettingsPad, SettingsSection } from './SettingsSection.js';

const NOTE = 'Receive assigned organization connectors in this agent’s memory. Sync alone does not enable live tools or move local connectors.';
const sourceNote = {
  saved: 'Saved on this server. This setting overrides its sync environment flag.',
  environment: 'Using this server’s sync environment flag. Changing this switch saves an override.',
  default: 'Off by default. Changing this switch saves a setting on this server.',
  invalid: 'The saved sync setting is invalid, so sync is off. Save a new setting to replace it.',
  scope_changed: 'The organization or enrollment changed, so the saved sync setting is off. Save again for this identity.',
};

function useCurrentStatus(status: ConnectorSyncStatus | undefined): ConnectorSyncStatus | undefined {
  const [, tick] = useState(0);
  const current = status === undefined ? undefined : currentSyncStatus(status);
  const expiresAt = current?.state === 'received' ? current.leaseExpiresAt : null;
  useEffect(() => {
    if (expiresAt === null) return;
    const timer = setTimeout(() => { tick((value) => value + 1); }, Math.min(Math.max(expiresAt - Date.now(), 0) + 1, 2_147_483_647));
    return () => { clearTimeout(timer); };
  }, [expiresAt]);
  return current;
}

function ReceiptTimes({ status }: { status: ConnectorSyncStatus }): ReactNode {
  return <>
    {status.lastReceivedAt === null ? null : <Text size="2xs" role="secondary">{`Last verified receipt: ${new Date(status.lastReceivedAt).toLocaleString()}`}</Text>}
    {status.state !== 'received' || status.leaseExpiresAt === null ? null : <Text size="2xs" role="secondary">{`Receipt expires: ${new Date(status.leaseExpiresAt).toLocaleString()}`}</Text>}
  </>;
}

function SyncDetails({ status }: { status: ConnectorSyncStatus }): ReactNode {
  return <>
    <Text size="2xs">{syncReceiptLabel(status)}</Text>
    {!status.enrolled && status.state !== 'not_enrolled' ? <Text size="2xs" role="secondary">Enroll this agent with the organization before enabling sync.</Text> : null}
    <Text size="2xs" role="secondary">{sourceNote[status.source]}</Text>
    <Text size="2xs" role={status.liveEnabled ? 'danger' : 'secondary'}>{status.liveEnabled ? 'The live organization tools flag is enabled in the server environment and controlled elsewhere. This switch does not change that flag. Turn that setting off before enabling sync here.' : 'Live organization tools are off. This switch does not enable them.'}</Text>
    {status.enrolled ? <Text size="2xs" role="secondary">Enrollment is confirmed locally, not a fresh check with the organization service.</Text> : null}
    <ReceiptTimes status={status} />
  </>;
}

function SyncSection({ server, scope }: { server: Server; scope: string }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const sync = useConnectorSync(server, scope);
  const status = useCurrentStatus(sync.status);
  const pending = sync.saving ? 'Saving sync setting…' : 'Checking sync status…';
  return <SettingsGroup title="Organization connectors">
    <SettingsSection title="Sync org connectors" note={NOTE}>
      {status === undefined ? <Text size="2xs" role="secondary">{sync.busy ? pending : 'Sync status is not available.'}</Text> : <Switch name="Sync org connectors" checked={status.enabled} dark={dark} disabled={!status.enabled && (!status.enrolled || status.liveEnabled)} onChange={sync.save} />}
    </SettingsSection>
    <SettingsPad>
      <Col gap={8}>
        {status === undefined ? null : <SyncDetails status={status} />}
        {sync.error === null ? null : <Text size="2xs" role="danger">{sync.error}</Text>}
        <Row><Button color="secondary" dark={dark} label="Refresh status" disabled={sync.busy} onPress={sync.refresh} /></Row>
      </Col>
    </SettingsPad>
  </SettingsGroup>;
}

export function ConnectorSync({ server }: { server: Server }): ReactNode {
  const account = useConnectorScope();
  const enrollment = useSyncExternalStore(subscribeEnrollmentScope, enrollmentScopeIdentity, enrollmentScopeIdentity);
  if (activeAccount()?.role !== 'admin') return null;
  if (enrollmentRunning()) return <SettingsGroup title="Organization connectors"><SettingsSection title="Sync org connectors" note={NOTE}><Text size="2xs" role="secondary">Waiting for enrollment to finish…</Text></SettingsSection></SettingsGroup>;
  const scope = `${String(account)}:${String(enrollment)}:${server.id}:${server.host}`;
  return <SyncSection key={scope} scope={scope} server={server} />;
}
