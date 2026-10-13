import { type ReactNode, useState } from 'react';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { currentServer } from '@metro-labs/client/auth/daemon';
import { connectorLabel } from '@metro-labs/client/api/connectors';
import { routeHash } from '@metro-labs/client/route';
import { useConnectorScope, useOrgConnectorsQuery } from '../lib/org-connector-queries.js';
import { queryError } from '../lib/queries.js';
import { useAgentName } from '../lib/agent-hooks.js';
import { SettingsGroup, SettingsPad, SettingsSection } from './SettingsSection.js';
import { Modal } from './Modal.js';
import { OrgConnectorPermissions } from './OrgConnectorPermissions.js';
import { RouteLink } from './RouteLink.js';

function AssignedNotice({ loading, empty, error }: { loading: boolean; empty: boolean; error: unknown }): ReactNode {
  if (error !== null) return <SettingsPad><Text size="2xs" role="danger">{queryError(error, 'Could not load organization connectors.')}</Text></SettingsPad>;
  if (!loading && !empty) return null;
  return <SettingsPad><Text size="2xs" role="secondary">{loading ? 'Loading organization connectors…' : 'No organization connector is assigned to this agent.'}</Text></SettingsPad>;
}

function Assigned(): ReactNode {
  const dark = useKitScheme() === 'dark';
  const name = useAgentName();
  const agentId = currentServer()?.id;
  const { data, error } = useOrgConnectorsQuery();
  const [selected, setSelected] = useState<string | null>(null);
  const assigned = data?.connectors.filter((connector) => connector.agents.some((agent) => agent.id === agentId)) ?? [];
  const connector = assigned.find((row) => row.id === selected);
  const agent = connector?.agents.find((row) => row.id === agentId);
  return (
    <SettingsGroup title="Organization connectors" note="Organization permissions apply to this agent. Its own rules can restrict them further.">
      <AssignedNotice loading={data === undefined} empty={assigned.length === 0} error={error} />
      {assigned.map((row) => (
        <SettingsSection key={row.id} title={connectorLabel(row, assigned)} note={`Instance ${row.id}`}>
          <Button size="md" color="secondary" dark={dark} label="Permissions" onPress={() => { setSelected(row.id); }} />
        </SettingsSection>
      ))}
      {connector === undefined || agent === undefined ? null : (
        <Modal title={`${name} permissions`} open onClose={() => { setSelected(null); }}>
          <RouteLink to={routeHash({ kind: 'org-connector', id: connector.id })}><Text size="2xs" role="link">{connectorLabel(connector)}</Text></RouteLink>
          <OrgConnectorPermissions connector={connector} agent={agent} admin={data?.admin === true} title="Agent permissions" />
        </Modal>
      )}
    </SettingsGroup>
  );
}

export function AgentOrgConnectors(): ReactNode {
  const scope = useConnectorScope();
  return <Assigned key={`${String(scope)}:${currentServer()?.id ?? ''}`} />;
}
