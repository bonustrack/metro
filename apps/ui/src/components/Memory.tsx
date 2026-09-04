import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui';
import { SHRINK } from '../theme';
import { BackLink } from './BackLink';
import { ClaudeProjects } from './ClaudeProjects';
import { Loading } from './Loading';
import { MarkdownBlock } from './MarkdownBlock';
import { PageTitle } from './PageTitle';
import { applyRoute, routeHash, routeSelection } from '../route';
import { type Selection } from './selection';
import { type MemoryFile } from '../api/claude';
import { queryError, useMemoryFileQuery, useMemoryQuery } from '../api/queries';
import { sizeLabel, whenLabel } from '../api/when';
import { useDocumentTitle } from '../title';

const ROW_PAD_Y = 10;

function FileRow({ file, onOpen }: { file: MemoryFile; onOpen: () => void }): ReactNode {
  const palette = useKitPalette();
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
        <Text size="md" weight="semibold" numberOfLines={1} style={SHRINK}>
          {file.name}
        </Text>
        <Text size="sm" role="secondary" numberOfLines={1}>
          {sizeLabel(file.bytes)} · {whenLabel(file.modifiedAt)}
        </Text>
      </Row>
    </a>
  );
}

const MEMORY_LINK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.md$/;

function MemoryIndex({
  project,
  claudeProject,
  onOpen,
  onSelect,
}: {
  project: string;
  claudeProject: string;
  onOpen: (name: string) => void;
  onSelect: (selection: Selection) => void;
}): ReactNode {
  const { data, error } = useMemoryQuery(claudeProject);
  const resolveLink = (href: string): string | null =>
    MEMORY_LINK.test(href) ? routeHash({ kind: 'memory', project, claudeProject, file: href }) : null;
  const navigate = (hash: string): void => {
    const next = routeSelection(hash);
    if (next.kind !== 'none') {
      onSelect(next);
      applyRoute(next, false);
    }
  };
  if (error !== null) return <Text size="sm" role="danger">{queryError(error, 'Could not read the memory.')}</Text>;
  if (data === undefined) return <Loading />;
  return (
    <Col gap={16}>
      {data.index === null ? (
        <Text size="sm" role="secondary">No MEMORY.md in this project yet.</Text>
      ) : (
        <MarkdownBlock text={data.index} resolveLink={resolveLink} onNavigate={navigate} />
      )}
      {data.files.length === 0 ? null : (
        <Col gap={6}>
          <Text size="lg" weight="semibold">
            Files
          </Text>
          <Col>
            {data.files.map((f) => (
              <FileRow
                key={f.name}
                file={f}
                onOpen={() => {
                  onOpen(f.name);
                }}
              />
            ))}
          </Col>
        </Col>
      )}
      <Text size="sm" role="secondary">Refreshes every few seconds; what Claude writes shows up here.</Text>
    </Col>
  );
}

function MemoryFileView({ claudeProject, file }: { claudeProject: string; file: string }): ReactNode {
  const { data, error } = useMemoryFileQuery(claudeProject, file);
  if (error !== null) return <Text size="sm" role="danger">{queryError(error, 'Could not read the file.')}</Text>;
  if (data === undefined) return <Loading />;
  return <MarkdownBlock text={data} />;
}

interface MemoryProps {
  project: string;
  claudeProject: string | null;
  file: string | null;
  onSelect: (selection: Selection) => void;
}

export function Memory({ project, claudeProject, file, onSelect }: MemoryProps): ReactNode {
  useDocumentTitle('Memory');
  if (claudeProject === null)
    return (
      <Col gap={16}>
        <PageTitle>Memory</PageTitle>
        <Text size="sm" role="secondary">
          What Claude Code remembers about each project on this machine. Pick a project.
        </Text>
        <ClaudeProjects
          onlyWithMemory
          onOpen={(cp) => {
            onSelect({ kind: 'memory', project, claudeProject: cp, file: null });
          }}
        />
      </Col>
    );
  const index: Selection = { kind: 'memory', project, claudeProject, file: null };
  if (file === null)
    return (
      <Col gap={16}>
        <BackLink
          label="Projects"
          href={routeHash({ kind: 'memory', project, claudeProject: null, file: null })}
          onPress={() => {
            onSelect({ kind: 'memory', project, claudeProject: null, file: null });
          }}
        />
        <PageTitle>Memory</PageTitle>
        <MemoryIndex
          project={project}
          claudeProject={claudeProject}
          onOpen={(name) => {
            onSelect({ kind: 'memory', project, claudeProject, file: name });
          }}
          onSelect={onSelect}
        />
      </Col>
    );
  return (
    <Col gap={16}>
      <BackLink
        label="Memory"
        href={routeHash(index)}
        onPress={() => {
          onSelect(index);
        }}
      />
      <PageTitle>{file}</PageTitle>
      <MemoryFileView claudeProject={claudeProject} file={file} />
    </Col>
  );
}
