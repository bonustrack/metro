import { type ReactNode } from 'react';
import { serverLabel } from '@metro-labs/client/api/servers';
import { currentServer } from '@metro-labs/client/auth/daemon';
import { AgentDeepPage } from '../agent/AgentDeepPage.js';
import { ExportSection } from '../ExportAgent.js';
import { ImportSection } from '../ImportAgent.js';
import { ErrorState } from '../ui/ErrorState.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { StateBlock } from '../ui/StateBlock.js';
import { queryError, useServersQuery, useStationsQuery } from '../../lib/queries.js';
import { useDocumentTitle } from '../../lib/title.js';

const LEAD = 'A .metro file holds chats, skills, memory and conversations, locked with a passphrase.';

function useAgentLabel(): string | null {
  const servers = useServersQuery().data;
  const here = currentServer();
  const server = servers?.find((s) => s.id === here?.id);
  return server === undefined ? null : serverLabel(server);
}

function Sections(): ReactNode {
  const stations = useStationsQuery();
  const label = useAgentLabel();
  const agent = stations.data?.agent;
  if (stations.error !== null) return <ErrorState title="Could not read the agent" text={queryError(stations.error, 'The agent did not answer.')} onRetry={stations.refetch} />;
  if (stations.data === undefined) return <RowsSkeleton rows={4} leading={false} />;
  if (agent === undefined) return <StateBlock spinner title="Getting ready" text="The agent shows here within seconds." />;
  const portable = { id: agent.id, name: label ?? agent.name };
  return (
    <>
      <ExportSection agent={portable} />
      <ImportSection agent={portable} />
    </>
  );
}

export function BackupPage({ project }: { project: string }): ReactNode {
  useDocumentTitle('Backup');
  return (
    <AgentDeepPage project={project} tab="settings" trail={[{ label: 'Backup' }]} title="Backup" subtitle={LEAD}>
      <Sections />
    </AgentDeepPage>
  );
}
