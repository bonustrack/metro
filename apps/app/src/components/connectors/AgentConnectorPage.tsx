import { type ReactNode } from 'react';
import { currentServer } from '@metro-labs/client/auth/daemon';
import type { OrgConnector } from '@metro-labs/client/api/org-connectors';
import { routeHash } from '@metro-labs/client/route';
import { AgentDeepPage } from '../agent/AgentDeepPage.js';
import { ConnectorFavicon } from '../ConnectorFavicon.js';
import { TextLink } from '../TextLink.js';
import { ErrorState } from '../ui/ErrorState.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { StateBlock } from '../ui/StateBlock.js';
import { AVATAR_SIZE } from '../ui/sizes.js';
import { AgentRules, ResetRules, agentSubtitle } from './AgentRules.js';
import { ConnectorSummary } from './ConnectorSummary.js';
import { useAgentName } from '../../lib/agent-hooks.js';
import type { AgentTabId } from '../../lib/agent-tabs.js';
import { go } from '../../lib/nav.js';
import { useConnectorScope, useOrgConnectorsQuery } from '../../lib/org-connector-queries.js';
import { queryError } from '../../lib/queries.js';
import { useDocumentTitle } from '../../lib/title.js';

interface PageProps {
  project: string;
  id: string;
  remote?: boolean;
}

const tabOf = (remote: boolean): AgentTabId => (remote ? 'home' : 'tools');

function Waiting({ project, remote, children }: { project: string; remote: boolean; children: ReactNode }): ReactNode {
  return (
    <AgentDeepPage project={project} tab={tabOf(remote)} trail={[{ label: 'Connector' }]}>
      {children}
    </AgentDeepPage>
  );
}

function Page({ project, connector, admin, remote }: { project: string; connector: OrgConnector; admin: boolean; remote: boolean }): ReactNode {
  const name = useAgentName();
  const agentId = currentServer()?.id ?? project;
  return (
    <AgentDeepPage project={project} tab={tabOf(remote)} trail={[{ label: connector.name }]} title={connector.name} subtitle={agentSubtitle(connector, name)}
      leading={<ConnectorFavicon name={connector.name} url={connector.url} size={AVATAR_SIZE.header} />} action={admin ? <ResetRules connector={connector} agentId={agentId} /> : undefined}
      summary={<ConnectorSummary connector={connector} agentId={agentId} name={name} remote={remote} />}>
      <AgentRules connector={connector} agentId={agentId} name={name} admin={admin} onRemoved={() => { go({ kind: 'tools', project }); }} />
      <TextLink to={routeHash({ kind: 'org-connector', id: connector.id })}>{`Open ${connector.name} in Connectors`}</TextLink>
    </AgentDeepPage>
  );
}

function Body({ project, id, remote = false }: PageProps): ReactNode {
  const { data, error, refetch } = useOrgConnectorsQuery();
  const connector = data?.connectors.find((row) => row.id === id);
  useDocumentTitle(connector?.name ?? 'Connector');
  if (data === undefined && error !== null)
    return <Waiting project={project} remote={remote}><ErrorState title="Could not load this connector" text={queryError(error, 'Metro did not answer.')} onRetry={refetch} /></Waiting>;
  if (data === undefined) return <Waiting project={project} remote={remote}><RowsSkeleton rows={6} /></Waiting>;
  if (connector === undefined)
    return <Waiting project={project} remote={remote}><StateBlock icon="plug" title="This connector is gone" text="It is not in this organization any more." action={{ label: remote ? 'Back to Connectors' : 'Back to Tools', onPress: () => { go({ kind: 'tools', project }); } }} /></Waiting>;
  return <Page project={project} connector={connector} admin={data.admin} remote={remote} />;
}

export function AgentConnectorPage(props: PageProps): ReactNode {
  const scope = useConnectorScope();
  return <Body key={`${String(scope)}:${props.id}`} {...props} />;
}
