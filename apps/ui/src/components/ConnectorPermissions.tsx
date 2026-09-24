import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { useQueryClient } from '@tanstack/react-query';
import { Text } from './ui.js';
import { Permissions } from './Permissions.js';
import { fetchConnectorTools, setConnectorPolicy, type Connector } from '../api/connectors.js';
import { POLICY_SINCE, connectorToolGroups } from '../api/policy.js';
import { olderThan } from '../api/version.js';
import { refresh, useBoxQuery, useModeQuery } from '../api/queries.js';

export function ConnectorPermissions({ connector }: { connector: Connector }): ReactNode {
  const client = useQueryClient();
  const mode = useModeQuery();
  const tools = useBoxQuery(['connector-tools', connector.id], () => fetchConnectorTools(connector.id), { staleTime: 60_000, retry: false });
  if (olderThan(mode.data?.version ?? null, POLICY_SINCE))
    return (
      <Col gap={4}>
        <Text size="lg" weight="semibold">Permissions</Text>
        <Text size="sm" role="secondary">{`Needs metro ${POLICY_SINCE}. Update first, from the Server page.`}</Text>
      </Col>
    );
  if (tools.data === undefined || tools.data.length === 0) return null;
  return (
    <Permissions
      policy={connector.policy}
      tools={connectorToolGroups(tools.data)}
      store={(next) => setConnectorPolicy(connector.id, next)}
      onSaved={() => refresh(client, ['connector', connector.id])}
    />
  );
}
