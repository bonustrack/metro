import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Column } from '@stage-labs/kit/react-native/column';
import { Text } from '@stage-labs/kit/react-native/text';
import { completeOrgConnectorSignIn, setOrgConnectorPolicy, takeOrgConnectorReturn, type OrgConnector } from '@metro-labs/client/api/org-connectors';
import type { ToolPolicy } from '@metro-labs/client/api/policy';
import { isRemote, serverLabel } from '@metro-labs/client/api/servers';
import { routeHash } from '@metro-labs/client/route';
import type { ConnectorTab } from '@metro-labs/client/selection';
import { AgentFace } from './connectors/AgentFace.js';
import { AgentRules, ResetRules, agentSubtitle } from './connectors/AgentRules.js';
import { useAddAgent, ConnectorAgents } from './connectors/ConnectorAgents.js';
import { ConnectorHeader, RefreshTools, type ConnectorTabId } from './connectors/ConnectorHeader.js';
import { ConnectorSummary } from './connectors/ConnectorSummary.js';
import { ConnectorSettings } from './connectors/ConnectorSettings.js';
import { ToolExplorer, type NamedPolicy } from './connectors/ToolExplorer.js';
import { ErrorState } from './ui/ErrorState.js';
import { Groups } from './ui/Group.js';
import { PageHeader } from './ui/PageHeader.js';
import { RoundButton } from './ui/RoundButton.js';
import { RowsSkeleton } from './ui/RowsSkeleton.js';
import { StateBlock } from './ui/StateBlock.js';
import { AVATAR_SIZE } from './ui/sizes.js';
import { useAgentRows } from '../lib/agent-rows.js';
import { takeInitialOrgConnectorReturn } from '../lib/location.js';
import { logError } from '../lib/log.js';
import { go } from '../lib/nav.js';
import { refreshOrgConnectors, useConnectorScope, useOrgConnectorsQuery } from '../lib/org-connector-queries.js';
import { queryError, useServersQuery } from '../lib/queries.js';
import { useDocumentTitle } from '../lib/title.js';

interface Outcome {
  busy: boolean;
  note: string | null;
  error: string | null;
}

function useSignInReturn(onDone: () => void): Outcome {
  const [outcome, setOutcome] = useState<Outcome>({ busy: false, note: null, error: null });
  useEffect(() => {
    const back = takeInitialOrgConnectorReturn() ?? takeOrgConnectorReturn();
    if (back === null) return;
    if (back.kind === 'error') {
      setOutcome({ busy: false, note: null, error: back.error });
      return;
    }
    setOutcome({ busy: true, note: null, error: null });
    completeOrgConnectorSignIn(back.handoff)
      .then(() => {
        setOutcome({ busy: false, note: 'Signed in. Agents use the new sign-in from now on.', error: null });
        onDone();
      })
      .catch((err: unknown) => {
        setOutcome({ busy: false, note: null, error: queryError(err, 'The sign-in did not finish.') });
      });
  }, [onDone]);
  return outcome;
}

function Notes({ outcome }: { outcome: Outcome }): ReactNode {
  return (
    <>
      {outcome.busy ? <Text size="md" color="secondary">Finishing the sign-in…</Text> : null}
      {outcome.note === null ? null : <Text size="md" color="secondary">{outcome.note}</Text>}
      {outcome.error === null ? null : <Text size="md" color="danger">{outcome.error}</Text>}
    </>
  );
}

function useNamedAgents(connector: OrgConnector): NamedPolicy[] {
  const servers = useServersQuery().data ?? [];
  return connector.agents.map((agent) => {
    const server = servers.find((row) => row.id === agent.id);
    return { id: agent.id, name: server === undefined ? agent.id : serverLabel(server), policy: agent.policy };
  });
}

function OrganizationTools({ connector, admin }: { connector: OrgConnector; admin: boolean }): ReactNode {
  const client = useQueryClient();
  const agents = useNamedAgents(connector);
  const save = async (next: ToolPolicy): Promise<void> => {
    await setOrgConnectorPolicy(connector.id, next);
    await refreshOrgConnectors(client);
  };
  return <ToolExplorer connector={connector} scope={{ policy: connector.policy }} editable={admin} save={save} agents={agents} />;
}

function TabbedPage({ connector, admin, tab, outcome }: { connector: OrgConnector; admin: boolean; tab: ConnectorTabId; outcome: Outcome }): ReactNode {
  const adding = useAddAgent(connector);
  const add = admin ? <RoundButton label="Add an agent" icon="plus" onPress={adding.open} /> : undefined;
  return (
    <Groups>
      <ConnectorHeader connector={connector} tab={tab} action={tab === 'tools' ? <RefreshTools connector={connector} /> : tab === 'agents' ? add : undefined} />
      <Notes outcome={outcome} />
      {tab === 'tools' ? <OrganizationTools connector={connector} admin={admin} /> : null}
      {tab === 'agents' ? <ConnectorAgents connector={connector} admin={admin} /> : null}
      {tab === 'settings' ? <ConnectorSettings connector={connector} admin={admin} /> : null}
      {adding.modal}
    </Groups>
  );
}

function AgentPage({ connector, agentId, admin }: { connector: OrgConnector; agentId: string; admin: boolean }): ReactNode {
  const server = useServersQuery().data?.find((row) => row.id === agentId);
  const [row] = useAgentRows(server === undefined ? [] : [server]);
  const name = server === undefined ? 'This agent' : serverLabel(server);
  const crumbs = [
    { label: 'Connectors', href: routeHash({ kind: 'org-connectors' }) },
    { label: connector.name, href: routeHash({ kind: 'org-connector', id: connector.id, tab: 'agents' }) },
    { label: name },
  ];
  return (
    <Groups>
      <Column>
        <PageHeader crumbs={crumbs} title={name} subtitle={agentSubtitle(connector, name)} leading={server === undefined ? undefined : <AgentFace server={server} dot={row?.line.dot ?? null} size={AVATAR_SIZE.header} />}
          action={admin ? <ResetRules connector={connector} agentId={agentId} /> : undefined} />
        <ConnectorSummary connector={connector} agentId={agentId} name={name} remote={server !== undefined && isRemote(server)} />
      </Column>
      <AgentRules connector={connector} agentId={agentId} name={name} admin={admin} onRemoved={() => { go({ kind: 'org-connector', id: connector.id, tab: 'agents' }); }} />
    </Groups>
  );
}

interface PageProps {
  id: string;
  tab?: ConnectorTab;
  agent?: string;
}

function Body({ id, tab, agent }: PageProps): ReactNode {
  const client = useQueryClient();
  const { data, error, refetch } = useOrgConnectorsQuery();
  const reload = useCallback(() => {
    refreshOrgConnectors(client).catch(logError('org-connector'));
  }, [client]);
  const outcome = useSignInReturn(reload);
  const connector = data?.connectors.find((c) => c.id === id);
  useDocumentTitle(connector?.name ?? 'Connector');
  if (data === undefined && error !== null) return <ErrorState title="Could not load this connector" text={queryError(error, 'Metro did not answer.')} onRetry={refetch} />;
  if (data === undefined) return <RowsSkeleton rows={6} />;
  if (connector === undefined) return <StateBlock icon="plug" title="This connector is gone" text="It is not in this organization any more." action={{ label: 'Back to Connectors', onPress: () => { go({ kind: 'org-connectors' }); } }} />;
  if (agent !== undefined) return <AgentPage connector={connector} agentId={agent} admin={data.admin} />;
  return <TabbedPage connector={connector} admin={data.admin} tab={tab ?? 'tools'} outcome={outcome} />;
}

export function OrgConnectorPage(props: PageProps): ReactNode {
  const scope = useConnectorScope();
  return <Body key={`${String(scope)}:${props.id}`} {...props} />;
}
