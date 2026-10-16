import { Fragment, type ReactNode } from 'react';
import { activeAccount } from '@metro-labs/client/auth/account';
import { currentServer } from '@metro-labs/client/auth/daemon';
import { connectorHost, connectorLabel } from '@metro-labs/client/api/connectors';
import type { OrgConnector } from '@metro-labs/client/api/org-connectors';
import { routeHash } from '@metro-labs/client/route';
import { ConnectorFavicon } from '../ConnectorFavicon.js';
import { useAssignedConnectors } from '../AgentOrgConnectors.js';
import { ChoiceWord } from '../connectors/AgentFace.js';
import { orgConnectorStatus } from '../org-connector-status.js';
import { ErrorState } from '../ui/ErrorState.js';
import { Group } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { StateBlock } from '../ui/StateBlock.js';
import { technicalLine } from '../../lib/agent-line.js';
import { useAgentName } from '../../lib/agent-hooks.js';
import { effectiveRule, toolRulesText } from '../../lib/connector-summary.js';
import { go } from '../../lib/nav.js';
import { queryError } from '../../lib/queries.js';
import { useTechnicalDetails } from '../../lib/technical.js';
import { ICON_SIZE } from '../ui/sizes.js';

function RuleLine({ connector }: { connector: OrgConnector }): ReactNode {
  const own = connector.agents.find((agent) => agent.id === currentServer()?.id)?.policy ?? {};
  const rule = effectiveRule(connector.policy, own);
  return (
    <>
      {rule.parts.map((part, at) => (
        <Fragment key={part.label}>
          {`${at === 0 ? '' : ' · '}${part.label}: `}
          <ChoiceWord choice={part.choice} />
        </Fragment>
      ))}
      {rule.tools === 0 ? null : ` · ${toolRulesText(rule.tools)}`}
    </>
  );
}

function ConnectorRow({ connector, peers, admin, project }: { connector: OrgConnector; peers: OrgConnector[]; admin: boolean; project: string }): ReactNode {
  const technical = useTechnicalDetails();
  const signedOut = orgConnectorStatus(connector).bad;
  const outLine = admin ? 'Signed out. Sign in again on Connectors.' : 'Signed out. Ask an admin.';
  return (
    <Item
      title={connectorLabel(connector, peers)}
      subtitle={signedOut ? outLine : <RuleLine connector={connector} />}
      subtitleTone={signedOut ? 'danger' : 'secondary'}
      detail={technical ? technicalLine([connectorHost(connector.url), connector.id]) : undefined}
      leading={<ConnectorFavicon name={connector.name} url={connector.url} size={ICON_SIZE.lg} radius={6} />}
      href={routeHash({ kind: 'tools', project, connector: connector.id })}
    />
  );
}

function Contents({ project }: { project: string }): ReactNode {
  const name = useAgentName();
  const { connectors, admin, error, refetch } = useAssignedConnectors();
  if (connectors === undefined && error !== null) return <ErrorState title="Could not load the connectors" text={queryError(error, 'Try again in a moment.')} onRetry={refetch} />;
  if (connectors === undefined) return <RowsSkeleton rows={2} trailing={false} />;
  if (connectors.length === 0)
    return (
      <StateBlock icon="plug" title="No connector yet" text={`A connector gives ${name} tools, like a calendar, Notion or GitHub. An admin picks them on the Connectors page.`}
        action={{ label: 'Open Connectors', onPress: () => { go({ kind: 'org-connectors' }); } }} />
    );
  return connectors.map((row) => <ConnectorRow key={row.id} connector={row} peers={connectors} admin={admin} project={project} />);
}

export function ToolConnectors({ project }: { project: string }): ReactNode {
  const organization = activeAccount()?.organizationName ?? 'your organization';
  return (
    <Group label="Connectors" note={`From ${organization}. Admins pick who gets them.`}>
      <Contents project={project} />
    </Group>
  );
}
