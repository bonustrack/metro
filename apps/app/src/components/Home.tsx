import { type ReactNode } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { fetchClaudeProjects } from '@metro-labs/client/api/claude';
import { serverLabel } from '@metro-labs/client/api/servers';
import type { StationsView } from '@metro-labs/client/api/client';
import { currentServer } from '@metro-labs/client/auth/daemon';
import { routeHash } from '@metro-labs/client/route';
import { Groups } from './ui/Group.js';
import { ErrorState } from './ui/ErrorState.js';
import { WithRail } from './ui/Layout.js';
import { RowsSkeleton } from './ui/RowsSkeleton.js';
import { StateBlock } from './ui/StateBlock.js';
import { ApprovalCardView, type ApprovalContext } from './home/ApprovalCard.js';
import { AtAGlance } from './home/Glance.js';
import { RightNow } from './home/RightNow.js';
import { SetupChecklist } from './home/SetupChecklist.js';
import { ChannelAlerts } from './home/ChannelAlerts.js';
import { ConnectorActivity } from './home/ConnectorActivity.js';
import { GatewayActivity } from './home/GatewayActivity.js';
import { rightNow } from '../lib/right-now.js';
import { setupOf } from '../lib/setup-steps.js';
import { useBoxApprovals } from '../lib/agent-status.js';
import { useLinkWords } from '../lib/auto-enroll.js';
import { outdatedLine, useOutdatedProvider } from '../lib/outdated-provider.js';
import { queryError, useBoxQuery, useClaudeSessionQuery, useServersQuery, useStationsQuery } from '../lib/queries.js';
import { useModelQuery } from '../lib/model-queries.js';
import { useDocumentTitle } from '../lib/title.js';
import { useIsNarrow } from '../lib/media.js';

const CARD_GAP = 16;

function useAgentName(fallback: string | undefined): { name: string; serverId: string | null } {
  const servers = useServersQuery();
  const here = currentServer();
  const server = servers.data?.find((s) => s.id === here?.id);
  if (server !== undefined) return { name: serverLabel(server), serverId: server.id };
  return { name: fallback === undefined || fallback === '' ? 'This agent' : fallback, serverId: here?.id ?? null };
}

function useConversations(): number | undefined {
  const projects = useBoxQuery('claude-projects', fetchClaudeProjects, { staleTime: 60_000, retry: false });
  return projects.data?.reduce((sum, project) => sum + project.sessions, 0);
}

function Approvals({ context }: { context: ApprovalContext }): ReactNode {
  const { data, error, refetch } = useBoxApprovals();
  const approvals = data ?? [];
  if (approvals.length === 0 && error === null) return null;
  return (
    <Column gap={CARD_GAP}>
      {error === null ? null : <ErrorState title="Could not check for new approvals" text={queryError(error, 'The agent did not answer.')} onRetry={refetch} />}
      {approvals.map((approval) => (
        <ApprovalCardView key={approval.id} approval={approval} context={context} />
      ))}
    </Column>
  );
}

function NowSection({ project, setupOpen }: { project: string; setupOpen: boolean }): ReactNode {
  const session = useClaudeSessionQuery().data;
  if (session === undefined) return null;
  if (setupOpen && rightNow(session, Date.now()).active === 0) return null;
  return <RightNow session={session} project={project} />;
}

function HomeBody({ project, name, serverId, agentId, view }: { project: string; name: string; serverId: string | null; agentId: string; view: StationsView }): ReactNode {
  const model = useModelQuery().data;
  const conversations = useConversations();
  const narrow = useIsNarrow();
  const outdated = useOutdatedProvider();
  const link = useLinkWords(model?.sync)?.line ?? (outdated === null ? null : outdatedLine(outdated));
  const setup = setupOf({ name, project, model, groups: view.groups, conversations, link });
  return (
    <>
      <ChannelAlerts project={project} groups={view.groups} />
      <NowSection project={project} setupOpen={setup.open !== null} />
      <SetupChecklist setup={setup} agentId={agentId} groups={view.groups} />
      {serverId === null ? null : <GatewayActivity agent={serverId} href={routeHash({ kind: 'model', project })} />}
      {serverId === null ? null : <ConnectorActivity agent={serverId} />}
      {narrow ? <AtAGlance project={project} serverId={serverId} groups={view.groups} name={name} /> : null}
    </>
  );
}

function GlanceRail({ project, name, serverId }: { project: string; name: string; serverId: string | null }): ReactNode {
  const stations = useStationsQuery().data;
  const narrow = useIsNarrow();
  if (narrow || stations?.agent === undefined) return null;
  return <AtAGlance project={project} serverId={serverId} groups={stations.groups} name={name} rail />;
}

function HomeState({ project, name, serverId }: { project: string; name: string; serverId: string | null }): ReactNode {
  const stations = useStationsQuery();
  const agent = stations.data?.agent;
  if (stations.data === undefined && stations.error !== null)
    return <ErrorState title={`Could not load ${name}`} text={queryError(stations.error, 'The agent did not answer.')} onRetry={stations.refetch} />;
  if (stations.data === undefined) return <RowsSkeleton rows={3} />;
  if (agent === undefined) return <StateBlock spinner title={`${name} is getting ready`} text="Its agent shows here within seconds." />;
  return <HomeBody project={project} name={name} serverId={serverId} agentId={agent.id} view={stations.data} />;
}

export function Home({ project }: { project: string }): ReactNode {
  const stations = useStationsQuery().data;
  const { name, serverId } = useAgentName(stations?.agent?.name);
  useDocumentTitle(name);
  const context: ApprovalContext = { agentId: stations?.agent?.id ?? '', groups: stations?.groups ?? [], tools: stations?.tools ?? {} };
  return (
    <WithRail rail={<GlanceRail project={project} name={name} serverId={serverId} />}>
      <Groups>
        <Approvals context={context} />
        <HomeState project={project} name={name} serverId={serverId} />
      </Groups>
    </WithRail>
  );
}
