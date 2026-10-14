import { type ReactNode, useState } from 'react';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { currentServer } from '@metro-labs/client/auth/daemon';
import { connectorLabel } from '@metro-labs/client/api/connectors';
import type { OrgConnector } from '@metro-labs/client/api/org-connectors';
import { routeHash } from '@metro-labs/client/route';
import { useOrgConnectorsQuery } from '../lib/org-connector-queries.js';
import { useAgentName } from '../lib/agent-hooks.js';
import { SettingsGroup, SettingsSection } from './SettingsSection.js';
import { Modal } from './Modal.js';
import { OrgConnectorPermissions } from './OrgConnectorPermissions.js';
import { RouteLink } from './RouteLink.js';

interface AssignedConnectors {
  connectors: OrgConnector[] | undefined;
  admin: boolean;
  error: Error | null;
}

export function useAssignedConnectors(): AssignedConnectors {
  const agentId = currentServer()?.id;
  const { data, error } = useOrgConnectorsQuery();
  return {
    connectors: data?.connectors.filter((connector) => connector.agents.some((agent) => agent.id === agentId)),
    admin: data?.admin === true,
    error,
  };
}

export function AgentOrgConnectors({ assigned, admin }: { assigned: OrgConnector[]; admin: boolean }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const name = useAgentName();
  const agentId = currentServer()?.id;
  const [selected, setSelected] = useState<string | null>(null);
  const connector = assigned.find((row) => row.id === selected);
  const agent = connector?.agents.find((row) => row.id === agentId);
  return (
    <SettingsGroup note="Organization permissions apply to this agent. Its own rules can restrict them further.">
      {assigned.map((row) => (
        <SettingsSection key={row.id} title={connectorLabel(row, assigned)} note={`Instance ${row.id}`}>
          <Button size="md" color="secondary" dark={dark} label="Permissions" onPress={() => { setSelected(row.id); }} />
        </SettingsSection>
      ))}
      {connector === undefined || agent === undefined ? null : (
        <Modal title={`${name} permissions`} open onClose={() => { setSelected(null); }}>
          <RouteLink to={routeHash({ kind: 'org-connector', id: connector.id })}><Text size="md" role="link">{connectorLabel(connector)}</Text></RouteLink>
          <OrgConnectorPermissions connector={connector} agent={agent} admin={admin} title="Agent permissions" />
        </Modal>
      )}
    </SettingsGroup>
  );
}
