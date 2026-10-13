import { type ReactNode, useState } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Switch } from '@stage-labs/kit/react-native/switch';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { assignOrgConnector, unassignOrgConnector, type OrgConnector, type OrgConnectorAgent } from '@metro-labs/client/api/org-connectors';
import { connectorLabel } from '@metro-labs/client/api/connectors';
import { serverLabel, type Server } from '@metro-labs/client/api/servers';
import { AgentAvatar } from './AgentAvatar.js';
import { Modal } from './Modal.js';
import { OrgConnectorPermissions } from './OrgConnectorPermissions.js';
import { SettingsGroup, SettingsPad, SettingsSection } from './SettingsSection.js';
import { queryError, useServersQuery } from '../lib/queries.js';

const AVATAR = 28;
const NOTE = 'Give this connector only to the agents that need it. Each agent inherits organization permissions and can be restricted further.';

interface RowProps {
  server: Server;
  held: OrgConnectorAgent | undefined;
  admin: boolean;
  busy: boolean;
  onChange: (job: () => Promise<unknown>) => void;
  onPermissions: () => void;
  connector: string;
}

function AgentRow({ server, held, admin, busy, onChange, onPermissions, connector }: RowProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <SettingsSection title={serverLabel(server)} note={held === undefined ? 'Does not have it' : 'Organization policy applies; view effective tool permissions below.'} leading={<AgentAvatar seed={server.id} src={server.avatar} size={AVATAR} />}>
      <Row gap={16} align="center" wrap>
        {held === undefined ? null : <Button size="md" color="secondary" dark={dark} label="Permissions" onPress={onPermissions} />}
        <Switch label="Can use" checked={held !== undefined} dark={dark} disabled={!admin || busy}
          onChange={(on) => { onChange(() => (on ? assignOrgConnector(connector, server.id) : unassignOrgConnector(connector, server.id))); }} />
      </Row>
    </SettingsSection>
  );
}

export function OrgConnectorAgents({ connector, admin, onChanged }: { connector: OrgConnector; admin: boolean; onChanged: () => void }): ReactNode {
  const servers = useServersQuery();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const change = (job: () => Promise<unknown>): void => {
    setBusy(true);
    setError(null);
    job().then(onChanged).catch((err: unknown) => { setError(queryError(err, 'Could not change that agent.')); }).finally(() => { setBusy(false); });
  };
  const held = connector.agents.find((agent) => agent.id === selected);
  const server = servers.data?.find((agent) => agent.id === selected);
  return (
    <SettingsGroup title="Agents" note={NOTE}>
      {servers.error === null ? null : <SettingsPad><Text size="2xs" role="danger">{queryError(servers.error, 'Could not load the agents.')}</Text></SettingsPad>}
      {servers.data === undefined || servers.data.length === 0 ? (
        <SettingsPad><Text size="2xs" role="secondary">{servers.data === undefined ? 'Loading the agents…' : 'This organization has no agent yet.'}</Text></SettingsPad>
      ) : servers.data.map((agent) => (
        <AgentRow key={agent.id} server={agent} held={connector.agents.find((a) => a.id === agent.id)} admin={admin} busy={busy} onChange={change} connector={connector.id} onPermissions={() => { setSelected(agent.id); }} />
      ))}
      {error === null ? null : <SettingsPad><Text size="2xs" role="danger">{error}</Text></SettingsPad>}
      {held === undefined || server === undefined ? null : (
        <Modal title={`${serverLabel(server)} permissions`} open onClose={() => { setSelected(null); }}>
          <OrgConnectorPermissions connector={connector} agent={held} admin={admin} title={connectorLabel(connector)} />
        </Modal>
      )}
    </SettingsGroup>
  );
}
