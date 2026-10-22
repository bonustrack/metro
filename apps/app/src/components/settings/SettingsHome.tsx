import { type ReactNode } from 'react';
import { boxesOf, type BoxServer } from '@metro-labs/client/api/servers';
import { currentServer } from '@metro-labs/client/auth/daemon';
import { Groups } from '../ui/Group.js';
import { ErrorState } from '../ui/ErrorState.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { AdvancedGroup } from './AdvancedGroup.js';
import { DangerGroup } from './DangerGroup.js';
import { ModelGroup } from './ModelGroup.js';
import { ProfileGroup } from './ProfileGroup.js';
import { ServerGroup } from './ServerGroup.js';
import { TechnicalGroup } from './TechnicalGroup.js';
import { queryError, useServersQuery } from '../../lib/queries.js';
import { useTechnicalDetails } from '../../lib/technical.js';
import { useDocumentTitle } from '../../lib/title.js';

export function useCurrentServer(): { server: BoxServer | undefined; error: Error | null; retry: () => void } {
  const servers = useServersQuery();
  const here = currentServer();
  return {
    server: boxesOf(servers.data ?? []).find((s) => s.id === here?.id),
    error: servers.error,
    retry: () => {
      servers.refetch().catch(() => undefined);
    },
  };
}

export function AgentSettings({ project }: { project: string }): ReactNode {
  const { server, error, retry } = useCurrentServer();
  const technical = useTechnicalDetails();
  useDocumentTitle('Settings');
  if (server === undefined) {
    if (error === null) return <RowsSkeleton rows={4} leading={false} />;
    return <ErrorState title="Settings did not load" text={queryError(error, 'Could not read this agent.')} onRetry={retry} />;
  }
  return (
    <Groups>
      <ModelGroup project={project} />
      <ProfileGroup server={server} />
      <ServerGroup server={server} project={project} />
      {technical ? <TechnicalGroup server={server} /> : null}
      <AdvancedGroup server={server} project={project} />
      <DangerGroup server={server} />
    </Groups>
  );
}
