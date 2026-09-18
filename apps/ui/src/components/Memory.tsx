import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from './ui.js';
import { BackLink } from './BackLink.js';
import { useHomeProject } from './home-project.js';
import { ListRow } from './ListRow.js';
import { Loading } from './Loading.js';
import { MarkdownBlock } from './MarkdownBlock.js';
import { PageTitle } from './PageTitle.js';
import { routeHash } from '../route.js';
import { type Selection } from './selection.js';
import { type MemoryFile } from '../api/claude.js';
import { queryError, useMemoryFileQuery, useMemoryQuery } from '../api/queries.js';
import { ListHeader } from './ListHeader.js';
import { sizeLabel, whenLabel } from '../api/when.js';
import { useDocumentTitle } from '../title.js';

function FileRow({ file, onOpen }: { file: MemoryFile; onOpen: () => void }): ReactNode {
  return <ListRow title={file.name} detail={`${sizeLabel(file.bytes)} · ${whenLabel(file.modifiedAt)}`} onOpen={onOpen} />;
}

function MemoryIndex({ claudeProject, onOpen }: { claudeProject: string; onOpen: (name: string) => void }): ReactNode {
  const { data, error } = useMemoryQuery(claudeProject);
  if (error !== null) return <Text size="sm" role="danger">{queryError(error, 'Could not read the memory.')}</Text>;
  if (data === undefined) return <Loading />;
  return (
    <Col gap={16}>
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
  return <ListHeader title="Memory" count={data?.files.length} />;
}

const NONE = 'No Claude Code memory on this box yet. It fills in as Claude works.';

function MemoryList({ project, claudeProject, onSelect }: { project: string; claudeProject: string; onSelect: (selection: Selection) => void }): ReactNode {
  return (
    <Col gap={16}>
      <MemoryTitle claudeProject={claudeProject} />
      <MemoryIndex
        claudeProject={claudeProject}
        onOpen={(name) => {
          onSelect({ kind: 'memory', project, claudeProject, file: name });
        }}
      />
    </Col>
  );
}

export function Memory({ project, claudeProject, file, onSelect }: MemoryProps): ReactNode {
  useDocumentTitle('Memory');
  const home = useHomeProject();
  const picked = claudeProject ?? home.project;
  if (picked === null)
    return (
      <Col gap={16}>
        <PageTitle>Memory</PageTitle>
        {home.loading ? <Loading /> : <Text size="sm" role="secondary">{NONE}</Text>}
      </Col>
    );
  if (file === null) return <MemoryList project={project} claudeProject={picked} onSelect={onSelect} />;
  const index: Selection = { kind: 'memory', project, claudeProject: picked, file: null };
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
      <MemoryFileView claudeProject={picked} file={file} />
    </Col>
  );
}
