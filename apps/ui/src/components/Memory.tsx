import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui.js';
import { SHRINK } from '../theme.js';
import { BackLink } from './BackLink.js';
import { ClaudeProjects } from './ClaudeProjects.js';
import { Loading } from './Loading.js';
import { MarkdownBlock } from './MarkdownBlock.js';
import { PageTitle } from './PageTitle.js';
import { routeHash } from '../route.js';
import { type Selection } from './selection.js';
import { type MemoryFile } from '../api/claude.js';
import { queryError, useMemoryFileQuery, useMemoryQuery } from '../api/queries.js';
import { CountBadge } from './CountBadge.js';
import { sizeLabel, whenLabel } from '../api/when.js';
import { useDocumentTitle } from '../title.js';

const ROW_PAD_Y = 4;

function FileRow({ file, onOpen }: { file: MemoryFile; onOpen: () => void }): ReactNode {
  const palette = useKitPalette();
  return (
    <Row align="center" border={{ bottom: { width: 1, color: palette.border } }}>
      <a
        className="row-link"
        href="#"
        onClick={(e) => {
          e.preventDefault();
          onOpen();
        }}
      >
        <Row gap={10} align="center" flex={1} minWidth={0} padding={{ y: ROW_PAD_Y }}>
          <Text size="md" weight="semibold" numberOfLines={1} style={SHRINK}>
            {file.name}
          </Text>
          <Text size="sm" role="secondary" numberOfLines={1}>
            {sizeLabel(file.bytes)} · {whenLabel(file.modifiedAt)}
          </Text>
        </Row>
      </a>
    </Row>
  );
}

function MemoryIndex({ claudeProject, onOpen }: { claudeProject: string; onOpen: (name: string) => void }): ReactNode {
  const { data, error } = useMemoryQuery(claudeProject);
  if (error !== null) return <Text size="sm" role="danger">{queryError(error, 'Could not read the memory.')}</Text>;
  if (data === undefined) return <Loading />;
  return (
    <Col gap={16}>
      <Text size="sm" role="secondary">Refreshes every few seconds; what Claude writes shows up here.</Text>
      {data.files.length === 0 ? (
        <Text size="sm" role="secondary">No memory in this project yet.</Text>
      ) : (
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
      )}
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

function MemoryTitle({ claudeProject }: { claudeProject: string }): ReactNode {
  const { data } = useMemoryQuery(claudeProject);
  return (
    <Row gap={10} align="center">
      <PageTitle>Memory</PageTitle>
      {data === undefined ? null : <CountBadge count={data.files.length} beside="title" />}
    </Row>
  );
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
        <MemoryTitle claudeProject={claudeProject} />
        <MemoryIndex
          claudeProject={claudeProject}
          onOpen={(name) => {
            onSelect({ kind: 'memory', project, claudeProject, file: name });
          }}
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
