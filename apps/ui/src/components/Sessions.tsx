import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui';
import { SHRINK } from '../theme';
import { BackLink } from './BackLink';
import { ClaudeProjects } from './ClaudeProjects';
import { Loading } from './Loading';
import { PageTitle } from './PageTitle';
import { SessionMenu } from './SessionMenu';
import { Transcript } from './Transcript';
import { opensElsewhere } from './link';
import { routeHash } from '../route';
import { type Selection } from './selection';
import { type ClaudeSession } from '../api/claude';
import { queryError, useClaudeSessionsQuery } from '../api/queries';
import { sizeLabel, whenLabel } from '../api/when';
import { useDocumentTitle } from '../title';

const ROW_PAD_Y = 12;

function SessionRow({
  token,
  claudeProject,
  session,
  target,
  onOpen,
}: {
  token: string;
  claudeProject: string;
  session: ClaudeSession;
  target: Selection;
  onOpen: () => void;
}): ReactNode {
  const palette = useKitPalette();
  const detail = [session.lastAt === null ? null : whenLabel(session.lastAt), session.gitBranch, sizeLabel(session.bytes)]
    .filter((s): s is string => s !== null)
    .join(' · ');
  return (
    <Row justify="between" align="center" gap={12} border={{ bottom: { width: 1, color: palette.border } }}>
      <a
        className="row-link"
        href={routeHash(target)}
        onClick={(e) => {
          if (opensElsewhere(e)) return;
          e.preventDefault();
          onOpen();
        }}
      >
        <Col style={SHRINK} flex={1} padding={{ y: ROW_PAD_Y }}>
          <Text size="md" weight="semibold" numberOfLines={1}>
            {session.title}
          </Text>
          <Text size="sm" role="secondary" numberOfLines={1}>
            {detail}
          </Text>
        </Col>
      </a>
      <SessionMenu token={token} claudeProject={claudeProject} id={session.id} title={session.title} onDeleted={() => undefined} />
    </Row>
  );
}

function SessionList({
  token,
  project,
  claudeProject,
  onOpen,
}: {
  token: string;
  project: string;
  claudeProject: string;
  onOpen: (id: string) => void;
}): ReactNode {
  const { data, error } = useClaudeSessionsQuery(token, claudeProject);
  if (error !== null) return <Text size="sm" role="danger">{queryError(error, 'Could not list the sessions.')}</Text>;
  if (data === undefined) return <Loading />;
  if (data.length === 0) return <Text size="sm" role="secondary">No session here yet.</Text>;
  return (
    <Col>
      {data.map((s) => (
        <SessionRow
          key={s.id}
          token={token}
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
  token,
  project,
  claudeProject,
  id,
  onSelect,
}: {
  token: string;
  project: string;
  claudeProject: string;
  id: string;
  onSelect: (selection: Selection) => void;
}): ReactNode {
  const list: Selection = { kind: 'sessions', project, claudeProject, id: null };
  const { data } = useClaudeSessionsQuery(token, claudeProject);
  const title = data?.find((s) => s.id === id)?.title ?? id;
  useDocumentTitle(title);
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
          token={token}
          claudeProject={claudeProject}
          id={id}
          title={title}
          onDeleted={() => {
            onSelect(list);
          }}
        />
      </Row>
      <PageTitle>{title}</PageTitle>
      <Transcript token={token} project={claudeProject} id={id} />
    </Col>
  );
}

interface SessionsProps {
  token: string;
  project: string;
  claudeProject: string | null;
  id: string | null;
  onSelect: (selection: Selection) => void;
}

export function Sessions({ token, project, claudeProject, id, onSelect }: SessionsProps): ReactNode {
  useDocumentTitle('Sessions');
  if (claudeProject === null)
    return (
      <Col gap={16}>
        <PageTitle>Sessions</PageTitle>
        <Text size="sm" role="secondary">
          Claude Code sessions on this machine, read from its own files. Pick a project.
        </Text>
        <ClaudeProjects
          token={token}
          onlyWithMemory={false}
          onOpen={(cp) => {
            onSelect({ kind: 'sessions', project, claudeProject: cp, id: null });
          }}
        />
      </Col>
    );
  if (id === null)
    return (
      <Col gap={16}>
        <BackLink
          label="Projects"
          href={routeHash({ kind: 'sessions', project, claudeProject: null, id: null })}
          onPress={() => {
            onSelect({ kind: 'sessions', project, claudeProject: null, id: null });
          }}
        />
        <PageTitle>Sessions</PageTitle>
        <SessionList
          token={token}
          project={project}
          claudeProject={claudeProject}
          onOpen={(sid) => {
            onSelect({ kind: 'sessions', project, claudeProject, id: sid });
          }}
        />
      </Col>
    );
  return <SessionView token={token} project={project} claudeProject={claudeProject} id={id} onSelect={onSelect} />;
}
