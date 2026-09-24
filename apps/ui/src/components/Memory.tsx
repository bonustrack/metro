import { type ReactNode, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Icon } from '@stage-labs/kit/react-native/icon';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui.js';
import { BackLink } from './BackLink.js';
import { useHomeProject } from './home-project.js';
import { LIST_ICON_SIZE, ListRow } from './ListRow.js';
import { fileLeaf, memoryTree, treeRows, type TreeRow } from './memory-tree.js';
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

const INDENT = 20;
const CARET = 16;
const OPEN_KEY = 'metro.memory.open:';

function readOpen(project: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(`${OPEN_KEY}${project}`);
    const list: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set(Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeOpen(project: string, open: Set<string>): void {
  try {
    window.localStorage.setItem(`${OPEN_KEY}${project}`, JSON.stringify([...open]));
  } catch {
    return;
  }
}

function TreeIcon({ depth, caret, name }: { depth: number; caret: 'chevronRight' | 'chevronDown' | null; name: 'folder' | 'folderOpen' | 'documentText' }): ReactNode {
  const palette = useKitPalette();
  return (
    <Row align="center" gap={6} padding={{ left: depth * INDENT }}>
      <Row width={CARET} justify="center">
        {caret === null ? null : <Icon name={caret} size={CARET} color={palette.sub} />}
      </Row>
      <Icon name={name} size={LIST_ICON_SIZE} color={name === 'documentText' ? palette.sub : palette.link} />
    </Row>
  );
}

function FolderRow({ row, onToggle }: { row: Extract<TreeRow, { kind: 'folder' }>; onToggle: () => void }): ReactNode {
  const { folder, open, depth } = row;
  const files = `${String(folder.count)} ${folder.count === 1 ? 'file' : 'files'}`;
  return (
    <ListRow
      title={folder.name}
      detail={folder.modifiedAt === '' ? files : `${files} · ${whenLabel(folder.modifiedAt)}`}
      icon={<TreeIcon depth={depth} caret={open ? 'chevronDown' : 'chevronRight'} name={open ? 'folderOpen' : 'folder'} />}
      onOpen={onToggle}
    />
  );
}

function FileRow({ claudeProject, depth, file, onOpen }: { claudeProject: string; depth: number; file: MemoryFile; onOpen: () => void }): ReactNode {
  const client = useQueryClient();
  return (
    <ListRow
      title={fileLeaf(file.name)}
      detail={`${sizeLabel(file.bytes)} · ${whenLabel(file.modifiedAt)}`}
      icon={<TreeIcon depth={depth} caret={null} name="documentText" />}
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
  const [open, setOpen] = useState(() => readOpen(claudeProject));
  const tree = useMemo(() => memoryTree(data?.files ?? []), [data]);
  if (error !== null) return <Text size="sm" role="danger">{queryError(error, 'Could not read the memory.')}</Text>;
  if (data === undefined) return <Loading />;
  if (data.files.length === 0) return <Text size="sm" role="secondary">No memory in this project yet.</Text>;
  const toggle = (path: string): void => {
    const next = new Set(open);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    writeOpen(claudeProject, next);
    setOpen(next);
  };
  return (
    <Col>
      {treeRows(tree, open).map((row) =>
        row.kind === 'folder' ? (
          <FolderRow
            key={`d:${row.folder.path}`}
            row={row}
            onToggle={() => {
              toggle(row.folder.path);
            }}
          />
        ) : (
          <FileRow
            key={`f:${row.file.name}`}
            claudeProject={claudeProject}
            depth={row.depth}
            file={row.file}
            onOpen={() => {
              onOpen(row.file.name);
            }}
          />
        ),
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
