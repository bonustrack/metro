import { type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from './ui.js';
import { BackLink } from './BackLink.js';
import { useHomeProject } from './home-project.js';
import { ListRow } from './ListRow.js';
import { DeleteMenu } from './DeleteMenu.js';
import { Loading } from './Loading.js';
import { MarkdownBlock } from './MarkdownBlock.js';
import { PageTitle } from './PageTitle.js';
import { routeHash } from '../route.js';
import { type Selection } from './selection.js';
import { deleteMemoryFile, type MemoryFile } from '../api/claude.js';
import { queryError, refresh, useMemoryFileQuery, useMemoryQuery } from '../api/queries.js';
import { ListHeader } from './ListHeader.js';
import { sizeLabel, whenLabel } from '../api/when.js';
import { useDocumentTitle } from '../title.js';

function FileRow({ claudeProject, file, onOpen }: { claudeProject: string; file: MemoryFile; onOpen: () => void }): ReactNode {
  const client = useQueryClient();
  return (
    <ListRow
      title={file.name}
      detail={`${sizeLabel(file.bytes)} · ${whenLabel(file.modifiedAt)}`}
      onOpen={onOpen}
      trailing={
        <DeleteMenu
          label={`Actions for ${file.name}`}
          action="Delete memory"
          title="Delete this memory?"
          lines={[`“${file.name}” is removed from this machine. Claude writes a new one if it learns the same thing again.`]}
          failure="Could not delete the memory."
          run={async () => {
            await deleteMemoryFile(claudeProject, file.name);
            await refresh(client, ['memory', claudeProject]);
          }}
        />
      }
    />
  );
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
                claudeProject={claudeProject}
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
