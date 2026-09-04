import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui';
import { SHRINK } from '../theme';
import { BackLink } from './BackLink';
import { ClaudeProjects } from './ClaudeProjects';
import { Loading } from './Loading';
import { PageTitle } from './PageTitle';
import { Transcript } from './Transcript';
import { routeHash } from '../route';
import { type Selection } from './selection';
import { type ClaudeSession } from '../api/claude';
import { queryError, useClaudeSessionsQuery } from '../api/queries';
import { sizeLabel, whenLabel } from '../api/when';
import { useDocumentTitle } from '../title';

const ROW_PAD_Y = 12;

function SessionRow({ session, onOpen }: { session: ClaudeSession; onOpen: () => void }): ReactNode {
  const palette = useKitPalette();
  const detail = [
    session.lastAt === null ? null : whenLabel(session.lastAt),
    session.gitBranch,
    sizeLabel(session.bytes),
  ]
    .filter((s): s is string => s !== null)
    .join(' · ');
  return (
    <a
      className="row-link"
      href="#"
      onClick={(e) => {
        e.preventDefault();
        onOpen();
      }}
    >
      <Row gap={10} align="center" flex={1} minWidth={0} padding={{ y: ROW_PAD_Y }} border={{ bottom: { width: 1, color: palette.border } }}>
        <Col style={SHRINK} flex={1}>
          <Text size="md" weight="semibold" numberOfLines={1}>
            {session.title}
          </Text>
          <Text size="sm" role="secondary" numberOfLines={1}>
            {detail}
          </Text>
        </Col>
      </Row>
    </a>
  );
}

function SessionList({
  token,
  claudeProject,
  onOpen,
}: {
  token: string;
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
          session={s}
          onOpen={() => {
            onOpen(s.id);
          }}
        />
      ))}
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
  const list: Selection = { kind: 'sessions', project, claudeProject, id: null };
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
          claudeProject={claudeProject}
          onOpen={(sid) => {
            onSelect({ kind: 'sessions', project, claudeProject, id: sid });
          }}
        />
      </Col>
    );
  return (
    <Col gap={16}>
      <BackLink
        label="Sessions"
        href={routeHash(list)}
        onPress={() => {
          onSelect(list);
        }}
      />
      <Transcript token={token} project={claudeProject} id={id} />
    </Col>
  );
}
