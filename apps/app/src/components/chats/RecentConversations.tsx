import { type ReactNode } from 'react';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { type ClaudeSession } from '@metro-labs/client/api/claude';
import { whenLabel } from '@metro-labs/client/api/when';
import { routeHash } from '@metro-labs/client/route';
import { Icon } from '../Icon.js';
import { RouteLink } from '../RouteLink.js';
import { Item } from '../ui/Item.js';
import { Group } from '../ui/Group.js';
import { useHomeProject } from '../../lib/agent-hooks.js';
import { queryError, useClaudeSessionsQuery } from '../../lib/queries.js';

const SHOWN = 5;
const POLL_MS = 30_000;
const MARK = 24;
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
  const { data, error } = useClaudeSessionsQuery(claudeProject, POLL_MS);
  if (error !== null)
    return (
      <Group label={LABEL} error={queryError(error, 'Could not list the conversations.')}>
        {null}
      </Group>
    );
  if (data === undefined) return null;
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
          leading={<Icon name="chat" size={MARK} color={palette.text} />}
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
