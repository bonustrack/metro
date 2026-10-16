import { type ReactNode } from 'react';
import { ProjectGate } from './ProjectGate.js';
import { SessionMenu } from './SessionMenu.js';
import { Transcript } from './Transcript.js';
import { OtherFolders } from './OtherFolders.js';
import { AgentDeepPage } from './agent/AgentDeepPage.js';
import { sessionTitle } from './chats/RecentConversations.js';
import { ErrorState } from './ui/ErrorState.js';
import { Group } from './ui/Group.js';
import { RowsSkeleton } from './ui/RowsSkeleton.js';
import { StateBlock } from './ui/StateBlock.js';
import { Item } from './ui/Item.js';
import { routeHash } from '@metro-labs/client/route';
import { type Selection } from '@metro-labs/client/selection';
import { type ClaudeSession } from '@metro-labs/client/api/claude';
import { queryError, useClaudeSessionsQuery } from '../lib/queries.js';
import { whenLabel } from '@metro-labs/client/api/when';
import { useDocumentTitle } from '../lib/title.js';
import { go } from '../lib/nav.js';

const LABEL = 'Conversations';

function SessionRow({ session, target }: { session: ClaudeSession; target: Selection }): ReactNode {
  return <Item title={sessionTitle(session)} subtitle={session.lastAt === null ? undefined : whenLabel(session.lastAt)} href={routeHash(target)} />;
}

function SessionList({ project, claudeProject }: { project: string; claudeProject: string }): ReactNode {
  const { data, error, refetch } = useClaudeSessionsQuery(claudeProject);
  if (data === undefined)
    return error === null ? <RowsSkeleton rows={4} leading={false} /> : <ErrorState title="Could not list the conversations" text={queryError(error, 'The agent did not answer.')} onRetry={refetch} />;
  if (data.length === 0) return <StateBlock icon="chat" title="No conversation yet" text="Conversations show here once someone writes to the agent." />;
  return (
    <Group>
      {data.map((s) => (
        <SessionRow key={s.id} session={s} target={{ kind: 'sessions', project, claudeProject, id: s.id }} />
      ))}
    </Group>
  );
}

function SessionView({ project, claudeProject, id }: { project: string; claudeProject: string; id: string }): ReactNode {
  const list: Selection = { kind: 'sessions', project, claudeProject, id: null };
  const { data } = useClaudeSessionsQuery(claudeProject);
  const found = data?.find((s) => s.id === id);
  const title = found === undefined ? 'Conversation' : sessionTitle(found);
  useDocumentTitle(title);
  const menu = (
    <SessionMenu
      claudeProject={claudeProject}
      id={id}
      title={title}
      onDeleted={() => {
        go(list);
      }}
    />
  );
  return (
    <AgentDeepPage project={project} tab="chats" trail={[{ label: LABEL, href: routeHash(list) }, { label: title }]} title={title} action={menu}>
      <Transcript project={claudeProject} id={id} />
    </AgentDeepPage>
  );
}

interface SessionsProps {
  project: string;
  claudeProject: string | null;
  id: string | null;
}

const NONE = 'No Claude Code session on this box yet.';

export function Sessions({ project, claudeProject, id }: SessionsProps): ReactNode {
  useDocumentTitle(LABEL);
  const list = (picked: string): ReactNode => (
    <>
      <SessionList project={project} claudeProject={picked} />
      <OtherFolders project={project} shown={picked} />
    </>
  );
  const gate = <ProjectGate title={LABEL} claudeProject={claudeProject} none={NONE}>{list}</ProjectGate>;
  if (id === null)
    return (
      <AgentDeepPage project={project} tab="chats" trail={[{ label: LABEL }]} title={LABEL}>
        {gate}
      </AgentDeepPage>
    );
  return (
    <ProjectGate title={LABEL} claudeProject={claudeProject} none={NONE}>
      {(picked) => <SessionView project={project} claudeProject={picked} id={id} />}
    </ProjectGate>
  );
}
