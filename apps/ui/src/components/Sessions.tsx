import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui.js';
import { SHRINK } from '../theme.js';
import { BackLink } from './BackLink.js';
import { ClaudeProjects } from './ClaudeProjects.js';
import { Loading } from './Loading.js';
import { PageTitle } from './PageTitle.js';
import { SessionMenu } from './SessionMenu.js';
import { Transcript } from './Transcript.js';
import { opensElsewhere } from './link.js';
import { routeHash } from '../route.js';
import { type Selection } from './selection.js';
import { type ClaudeSession } from '../api/claude.js';
import { queryError, useClaudeSessionsQuery } from '../api/queries.js';
import { sizeLabel, whenLabel } from '../api/when.js';
import { useDocumentTitle } from '../title.js';

const ROW_PAD_Y = 12;

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
      <SessionMenu claudeProject={claudeProject} id={session.id} title={session.title} onDeleted={() => undefined} />
    </Row>
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
  const { data } = useClaudeSessionsQuery(claudeProject);
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
          claudeProject={claudeProject}
          id={id}
          title={title}
          onDeleted={() => {
            onSelect(list);
          }}
        />
      </Row>
      <PageTitle>{title}</PageTitle>
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

export function Sessions({ project, claudeProject, id, onSelect }: SessionsProps): ReactNode {
  useDocumentTitle('Sessions');
  if (claudeProject === null)
    return (
      <Col gap={16}>
        <PageTitle>Sessions</PageTitle>
        <Text size="sm" role="secondary">
          Claude Code sessions on this machine, read from its own files. Pick a project.
        </Text>
        <ClaudeProjects
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
          project={project}
          claudeProject={claudeProject}
          onOpen={(sid) => {
            onSelect({ kind: 'sessions', project, claudeProject, id: sid });
          }}
        />
      </Col>
    );
  return <SessionView project={project} claudeProject={claudeProject} id={id} onSelect={onSelect} />;
}
