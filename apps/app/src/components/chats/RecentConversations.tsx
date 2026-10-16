import { type ReactNode } from 'react';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { type ClaudeSession } from '@metro-labs/client/api/claude';
import { whenLabel } from '@metro-labs/client/api/when';
import { routeHash } from '@metro-labs/client/route';
import { Icon } from '../Icon.js';
import { RouteLink } from '../RouteLink.js';
import { Item } from '../ui/Item.js';
import { ICON_SIZE } from '../ui/sizes.js';
import { ErrorState } from '../ui/ErrorState.js';
import { Group } from '../ui/Group.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { useHomeProject } from '../../lib/agent-hooks.js';
import { queryError, useClaudeSessionsQuery } from '../../lib/queries.js';

const SHOWN = 5;
const POLL_MS = 30_000;
const LABEL = 'Recent conversations';

export const sessionTitle = (session: ClaudeSession): string => (session.title !== '' && session.title !== session.id ? session.title : 'Conversation');

const newest = (sessions: ClaudeSession[]): ClaudeSession[] => [...sessions].sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? '')).slice(0, SHOWN);

function ShowAll({ project }: { project: string }): ReactNode {
  return (
    <RouteLink to={routeHash({ kind: 'sessions', project, claudeProject: null, id: null })} label="Show all conversations">
      <Text size="xs">Show all</Text>
    </RouteLink>
  );
}

function Recent({ project, claudeProject }: { project: string; claudeProject: string }): ReactNode {
  const palette = useKitPalette();
  const { data, error, refetch } = useClaudeSessionsQuery(claudeProject, POLL_MS);
  if (data === undefined)
    return (
      <Group label={LABEL}>
        {error === null ? <RowsSkeleton rows={2} trailing={false} /> : <ErrorState title="Could not list the conversations" text={queryError(error, 'The agent did not answer.')} onRetry={refetch} />}
      </Group>
    );
  if (data.length === 0)
    return (
      <Group label={LABEL} note="No conversation yet.">
        {null}
      </Group>
    );
  return (
    <Group label={LABEL} action={<ShowAll project={project} />}>
      {newest(data).map((session) => (
        <Item
          key={session.id}
          title={sessionTitle(session)}
          leading={<Icon name="chat" size={ICON_SIZE.lg} color={palette.text} />}
          value={session.lastAt === null ? undefined : whenLabel(session.lastAt)}
          href={routeHash({ kind: 'sessions', project, claudeProject, id: session.id })}
          chevron={false}
        />
      ))}
    </Group>
  );
}

export function RecentConversations({ project }: { project: string }): ReactNode {
  const home = useHomeProject();
  if (home.project === null) return null;
  return <Recent project={project} claudeProject={home.project} />;
}
