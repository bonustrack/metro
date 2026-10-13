import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { connectorToolGroups } from '@metro-labs/client/api/policy';
import type { ConnectorTool } from '@metro-labs/client/api/connectors';
import { setOrgConnectorAgentPolicy, setOrgConnectorPolicy, type OrgConnector, type OrgConnectorAgent } from '@metro-labs/client/api/org-connectors';
import { Permissions } from './Permissions.js';
import { queryError } from '../lib/queries.js';
import { refreshOrgConnectors, useOrgConnectorToolsQuery } from '../lib/org-connector-queries.js';
import { logError } from '../lib/log.js';

interface Props {
  connector: OrgConnector;
  admin: boolean;
  agent?: OrgConnectorAgent;
  title?: string;
}

function CatalogueNotice({ rows, error }: { rows: ConnectorTool[] | undefined; error: unknown }): ReactNode {
  if (error !== null) return <Text size="md" role="danger">{queryError(error, 'Could not load the tools.')}{rows === undefined ? ' Saved permissions are kept.' : ' Showing the last tool list. Saved permissions are kept.'}</Text>;
  if (rows === undefined) return <Text size="md" role="secondary">Loading tools…</Text>;
  return rows.length === 0 ? <Text size="md" role="secondary">The provider returned no tools.</Text> : null;
}

export function OrgConnectorPermissions({ connector, admin, agent, title }: Props): ReactNode {
  const client = useQueryClient();
  const dark = useKitScheme() === 'dark';
  const tools = useOrgConnectorToolsQuery(connector.id);
  const rows = tools.data ?? [];
  return (
    <Col gap={12}>
      <Row justify="between" align="center" gap={12}>
        <Text size="md" role="secondary">Listing the tools runs none and allows none.</Text>
        <Button size="md" color="secondary" dark={dark} label="Refresh tools" loading={tools.isFetching} disabled={tools.isFetching} onPress={() => { tools.refetch().catch(logError('org-connector-tools')); }} />
      </Row>
      <Text size="md" role="secondary">Tools the provider marks read-only use Read, the rest use Write. Older agents may be stricter until updated.</Text>
      <CatalogueNotice rows={tools.data} error={tools.error} />
      <Permissions title={title ?? 'Organization permissions'} policy={agent?.policy ?? connector.policy} organization={agent === undefined ? undefined : connector.policy}
        tools={connectorToolGroups(rows)} titles={Object.fromEntries(rows.map((tool) => [tool.name, tool.title]))}
        descriptions={Object.fromEntries(rows.map((tool) => [tool.name, tool.description]))} disabled={!admin}
        store={(next) => agent === undefined ? setOrgConnectorPolicy(connector.id, next) : setOrgConnectorAgentPolicy(connector.id, agent.id, next)}
        onSaved={() => refreshOrgConnectors(client)} />
    </Col>
  );
}
