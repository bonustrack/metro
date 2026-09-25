import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from './ui.js';
import { BackLink } from './BackLink.js';
import { ProjectGate } from './ProjectGate.js';
import { ListRow } from './ListRow.js';
import { ListHeader } from './ListHeader.js';
import { Loading } from './Loading.js';
import { PageTitle } from './PageTitle.js';
import { SessionMenu } from './SessionMenu.js';
import { Transcript } from './Transcript.js';
import { routeHash } from '../route.js';
import { type Selection } from './selection.js';
import { type ClaudeSession } from '../api/claude.js';
import { queryError, useClaudeSessionsQuery } from '../api/queries.js';
import { sizeLabel, whenLabel } from '../api/when.js';
import { useDocumentTitle } from '../title.js';

function SessionRow({
  claudeProject,
  session,
  target,
  onOpen,
}: {
  claudeProject: string;
  session: ClaudeSession;
  target: Selection;
  onOpen: () => void;
}): ReactNode {
  const detail = [session.lastAt === null ? null : whenLabel(session.lastAt), session.gitBranch, sizeLabel(session.bytes)]
    .filter((s): s is string => s !== null)
    .join(' · ');
  return (
    <ListRow
      title={session.id}
      detail={detail}
      href={routeHash(target)}
      onOpen={onOpen}
      trailing={<SessionMenu claudeProject={claudeProject} id={session.id} title={session.id} onDeleted={() => undefined} />}
    />
  );
}

function SessionList({
  project,
  claudeProject,
  onOpen,
}: {
  project: string;
  claudeProject: string;
  onOpen: (id: string) => void;
}): ReactNode {
  const { data, error } = useClaudeSessionsQuery(claudeProject);
  if (error !== null) return <Text size="sm" role="danger">{queryError(error, 'Could not list the sessions.')}</Text>;
  if (data === undefined) return <Loading />;
  if (data.length === 0) return <Text size="sm" role="secondary">No session here yet.</Text>;
  return (
    <Col>
      {data.map((s) => (
        <SessionRow
          key={s.id}
          claudeProject={claudeProject}
          session={s}
          target={{ kind: 'sessions', project, claudeProject, id: s.id }}
          onOpen={() => {
            onOpen(s.id);
          }}
        />
      ))}
    </Col>
  );
}

function SessionView({
  project,
  claudeProject,
  id,
  onSelect,
}: {
  project: string;
  claudeProject: string;
  id: string;
  onSelect: (selection: Selection) => void;
}): ReactNode {
  const list: Selection = { kind: 'sessions', project, claudeProject, id: null };
  useDocumentTitle(id);
  return (
    <Col gap={16}>
      <Row justify="between" align="center" gap={12}>
        <BackLink
          label="Sessions"
          href={routeHash(list)}
          onPress={() => {
            onSelect(list);
          }}
        />
        <SessionMenu
          claudeProject={claudeProject}
          id={id}
          title={id}
          onDeleted={() => {
            onSelect(list);
          }}
        />
      </Row>
      <PageTitle>{id}</PageTitle>
      <Transcript project={claudeProject} id={id} />
    </Col>
  );
}

interface SessionsProps {
  project: string;
  claudeProject: string | null;
  id: string | null;
  onSelect: (selection: Selection) => void;
}

const NONE = 'No Claude Code session on this box yet.';

function SessionsTitle({ claudeProject }: { claudeProject: string }): ReactNode {
  const { data } = useClaudeSessionsQuery(claudeProject);
  return <ListHeader title="Sessions" count={data?.length} />;
}

export function Sessions({ project, claudeProject, id, onSelect }: SessionsProps): ReactNode {
  useDocumentTitle('Sessions');
  return (
    <ProjectGate title="Sessions" claudeProject={claudeProject} none={NONE}>
      {(picked) =>
        id === null ? (
          <Col gap={16}>
            <SessionsTitle claudeProject={picked} />
            <SessionList
              project={project}
              claudeProject={picked}
              onOpen={(sid) => {
                onSelect({ kind: 'sessions', project, claudeProject: picked, id: sid });
              }}
            />
          </Col>
        ) : (
          <SessionView project={project} claudeProject={picked} id={id} onSelect={onSelect} />
        )
      }
    </ProjectGate>
  );
}
