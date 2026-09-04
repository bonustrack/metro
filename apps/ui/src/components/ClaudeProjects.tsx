import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui';
import { SHRINK } from '../theme';
import { Loading } from './Loading';
import { type ClaudeProject } from '../api/claude';
import { queryError, useClaudeProjectsQuery } from '../api/queries';
import { whenLabel } from '../api/when';

const ROW_PAD_Y = 12;

export function projectLabel(project: ClaudeProject): string {
  return project.cwd ?? project.id;
}

function ProjectRow({ project, onOpen }: { project: ClaudeProject; onOpen: () => void }): ReactNode {
  const palette = useKitPalette();
  const detail = [
    `${String(project.sessions)} session${project.sessions === 1 ? '' : 's'}`,
    project.lastActiveAt === null ? null : `active ${whenLabel(project.lastActiveAt)}`,
    project.hasMemory ? 'memory' : null,
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
      <Row
        gap={10}
        align="center"
        flex={1}
        minWidth={0}
        padding={{ y: ROW_PAD_Y }}
        border={{ bottom: { width: 1, color: palette.border } }}
      >
        <Col style={SHRINK} flex={1}>
          <Text size="md" weight="semibold" numberOfLines={1}>
            {projectLabel(project)}
          </Text>
          <Text size="sm" role="secondary" numberOfLines={1}>
            {detail}
          </Text>
        </Col>
      </Row>
    </a>
  );
}

export function ClaudeProjects({
  token,
  onlyWithMemory,
  onOpen,
}: {
  token: string;
  onlyWithMemory: boolean;
  onOpen: (id: string) => void;
}): ReactNode {
  const { data, error } = useClaudeProjectsQuery(token);
  if (error !== null)
    return <Text size="sm" role="danger">{queryError(error, 'Could not list Claude Code projects.')}</Text>;
  if (data === undefined) return <Loading />;
  const rows = onlyWithMemory ? data.filter((p) => p.hasMemory) : data;
  if (rows.length === 0)
    return (
      <Text size="sm" role="secondary">
        {onlyWithMemory
          ? 'No project on this machine has Claude Code memory yet.'
          : 'No Claude Code session on this machine yet.'}
      </Text>
    );
  return (
    <Col>
      {rows.map((p) => (
        <ProjectRow
          key={p.id}
          project={p}
          onOpen={() => {
            onOpen(p.id);
          }}
        />
      ))}
    </Col>
  );
}
