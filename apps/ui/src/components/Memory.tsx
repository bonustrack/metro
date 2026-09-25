import { type ReactNode, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from './ui.js';
import { ProjectGate } from './ProjectGate.js';
import { Crumbs, EntryRow, type Crumb } from './FolderBrowser.js';
import { fileLeaf, memoryTree, type MemoryFolder } from './memory-tree.js';
import { DeleteMenu } from './DeleteMenu.js';
import { Loading } from './Loading.js';
import { MarkdownBlock } from './MarkdownBlock.js';
import { routeHash } from '../route.js';
import { type Selection } from './selection.js';
import { deleteMemoryFile, type MemoryFile } from '../api/claude.js';
import { queryError, refresh, useMemoryFileQuery, useMemoryQuery } from '../api/queries.js';
import { ListHeader } from './ListHeader.js';
import { EmptyCard, SettingsGroup } from './SettingsSection.js';
import { whenLabel } from '../api/when.js';
import { useDocumentTitle } from '../title.js';

const isFile = (path: string | null): path is string => path?.endsWith('.md') === true;

function noteTitle(name: string): string {
  const words = fileLeaf(name).replace(/\.md$/i, '').replace(/[_-]+/g, ' ').trim();
  return words === '' ? name : `${words.slice(0, 1).toUpperCase()}${words.slice(1)}`;
}

function folderAt(root: MemoryFolder, path: string): MemoryFolder | null {
  let at: MemoryFolder | undefined = root;
  for (const part of path.split('/').filter((p) => p !== '')) at = at?.folders.find((f) => f.name === part);
  return at ?? null;
}

const folderDetail = (folder: MemoryFolder): string => {
  const files = `${String(folder.count)} ${folder.count === 1 ? 'note' : 'notes'}`;
  return folder.modifiedAt === '' ? files : `${files} · ${whenLabel(folder.modifiedAt)}`;
};

function memoryCrumbs(project: string, claudeProject: string, path: string, onSelect: (s: Selection) => void): Crumb[] {
  const parts = path.split('/').filter((p) => p !== '');
  return ['Notes', ...parts].map((label, at) => {
    const folder = parts.slice(0, at).join('/');
    const target: Selection = { kind: 'memory', project, claudeProject, file: folder === '' ? null : folder };
    return { label: at === parts.length && isFile(path) ? noteTitle(label) : label, href: routeHash(target), onPress: () => { onSelect(target); } };
  });
}

function DeleteMemory({ claudeProject, file }: { claudeProject: string; file: MemoryFile }): ReactNode {
  const client = useQueryClient();
  return (
    <DeleteMenu
      label={`Actions for ${file.name}`}
      action="Delete note"
      title="Delete this note?"
      lines={[`“${noteTitle(file.name)}” is removed. The agent writes a new one if it learns the same thing again.`]}
      failure="Could not delete the note."
      run={async () => {
        await deleteMemoryFile(claudeProject, file.name);
        await refresh(client, ['memory', claudeProject]);
      }}
    />
  );
}

function MemoryFolderView({ project, claudeProject, path, onSelect }: { project: string; claudeProject: string; path: string; onSelect: (s: Selection) => void }): ReactNode {
  const { data, error } = useMemoryQuery(claudeProject);
  const tree = useMemo(() => memoryTree(data?.files ?? []), [data]);
  if (error !== null) return <Text size="sm" role="danger">{queryError(error, 'Could not read the memory.')}</Text>;
  if (data === undefined) return <Loading />;
  if (data.files.length === 0) return <EmptyCard text="No notes yet. The agent writes notes here as it learns about you and your work." />;
  const folder = folderAt(tree, path);
  if (folder === null) return <EmptyCard text="That folder is gone." />;
  const open = (target: Selection) => (): void => {
    onSelect(target);
  };
  return (
    <SettingsGroup>
      {folder.folders.map((child) => {
        const target: Selection = { kind: 'memory', project, claudeProject, file: child.path };
        return <EntryRow key={`d:${child.path}`} name={child.name} detail={folderDetail(child)} folder href={routeHash(target)} onOpen={open(target)} />;
      })}
      {folder.files.map((file) => {
        const target: Selection = { kind: 'memory', project, claudeProject, file: file.name };
        return (
          <EntryRow
            key={`f:${file.name}`}
            name={noteTitle(file.name)}
            detail={`Updated ${whenLabel(file.modifiedAt)}`}
            folder={false}
            href={routeHash(target)}
            onOpen={open(target)}
            trailing={<DeleteMemory claudeProject={claudeProject} file={file} />}
          />
        );
      })}
    </SettingsGroup>
  );
}

function MemoryFileView({ claudeProject, file }: { claudeProject: string; file: string }): ReactNode {
  const { data, error } = useMemoryFileQuery(claudeProject, file);
  if (error !== null) return <Text size="sm" role="danger">{queryError(error, 'Could not read the file.')}</Text>;
  if (data === undefined) return <Loading />;
  return (
    <SettingsGroup>
      <div className="settings-pad">
        <MarkdownBlock text={data} />
      </div>
    </SettingsGroup>
  );
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

export function Memory({ project, claudeProject, file, onSelect }: MemoryProps): ReactNode {
  useDocumentTitle('Notes');
  return (
    <ProjectGate title="Memory" claudeProject={claudeProject} none={NONE}>
      {(picked) => (
        <Col gap={16}>
          <MemoryTitle claudeProject={picked} />
          <Crumbs crumbs={memoryCrumbs(project, picked, file ?? '', onSelect)} />
          {isFile(file) ? (
            <MemoryFileView claudeProject={picked} file={file} />
          ) : (
            <MemoryFolderView project={project} claudeProject={picked} path={file ?? ''} onSelect={onSelect} />
          )}
        </Col>
      )}
    </ProjectGate>
  );
}
