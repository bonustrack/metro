import { type ReactNode, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col } from '@stage-labs/kit/react-native/box';
import { FONT_SIZE } from '@stage-labs/kit/tokens';
import { deleteMemoryFile } from '@metro-labs/client/api/claude';
import { whenLabel } from '@metro-labs/client/api/when';
import { routeHash } from '@metro-labs/client/route';
import { type Selection } from '@metro-labs/client/selection';
import { Crumbs, EntryRow, type Crumb } from './FolderBrowser.js';
import { DeleteMenu } from './DeleteMenu.js';
import { Loading } from './Loading.js';
import { MarkdownBlock } from './MarkdownBlock.js';
import { folderAt, memoryTree, noteLink, noteTitle, parentOf, type MemoryFolder } from './memory-tree.js';
import { Group, Groups } from './ui/Group.js';
import { PageHeader } from './ui/PageHeader.js';
import { StateBlock } from './ui/StateBlock.js';
import { useHomeProject } from '../lib/agent-hooks.js';
import { go } from '../lib/nav.js';
import { queryError, refresh, useMemoryFileQuery, useMemoryQuery } from '../lib/queries.js';
import { useDocumentTitle } from '../lib/title.js';

const NOTE_LINE = 26;
const EMPTY = 'The agent writes notes here as it learns about you and your work.';
const NONE = 'No Claude Code memory on this box yet. It fills in as Claude works.';

const isFile = (path: string | null): path is string => path?.endsWith('.md') === true;

const target = (project: string, claudeProject: string, path: string): Selection => ({ kind: 'memory', project, claudeProject, file: path === '' ? null : path });

function memoryCrumbs(project: string, claudeProject: string, path: string): Crumb[] {
  const parts = path.split('/').filter((p) => p !== '');
  return ['Notes', ...parts].map((label, at) => ({
    label: at === parts.length && isFile(path) ? noteTitle(label) : label,
    href: routeHash(target(project, claudeProject, parts.slice(0, at).join('/'))),
  }));
}

const folderDetail = (folder: MemoryFolder): string => {
  const files = `${String(folder.count)} ${folder.count === 1 ? 'note' : 'notes'}`;
  return folder.modifiedAt === '' ? files : `${files} · ${whenLabel(folder.modifiedAt)}`;
};

function FolderRows({ project, claudeProject, folder }: { project: string; claudeProject: string; folder: MemoryFolder }): ReactNode {
  return (
    <Groups>
      {folder.folders.length === 0 ? null : (
        <Group label="Folders">
          {folder.folders.map((child) => (
            <EntryRow key={child.path} name={child.name} detail={folderDetail(child)} folder href={routeHash(target(project, claudeProject, child.path))} />
          ))}
        </Group>
      )}
      {folder.files.length === 0 ? null : (
        <Group label="Notes">
          {folder.files.map((file) => (
            <EntryRow key={file.name} name={noteTitle(file.name)} detail={`Updated ${whenLabel(file.modifiedAt)}`} folder={false} href={routeHash(target(project, claudeProject, file.name))} />
          ))}
        </Group>
      )}
    </Groups>
  );
}

function FolderView({ project, claudeProject, path }: { project: string; claudeProject: string; path: string }): ReactNode {
  const { data, error } = useMemoryQuery(claudeProject);
  const tree = useMemo(() => memoryTree(data?.files ?? []), [data]);
  if (error !== null) return <StateBlock icon="exclamationCircle" danger title="Could not read the notes" text={queryError(error, 'Try again in a moment.')} />;
  if (data === undefined) return <Loading />;
  if (data.files.length === 0) return <StateBlock icon="documentText" title="No notes yet" text={EMPTY} />;
  const folder = folderAt(tree, path);
  if (folder === null) return <StateBlock icon="folder" title="That folder is gone" text="The agent moved or removed it." />;
  return <FolderRows project={project} claudeProject={claudeProject} folder={folder} />;
}

function DeleteNote({ project, claudeProject, file }: { project: string; claudeProject: string; file: string }): ReactNode {
  const client = useQueryClient();
  return (
    <DeleteMenu
      label={`Actions for ${noteTitle(file)}`}
      action="Delete note"
      title="Delete this note?"
      lines={[`“${noteTitle(file)}” is removed. The agent writes a new one if it learns the same thing again.`]}
      failure="Could not delete the note."
      run={async () => {
        await deleteMemoryFile(claudeProject, file);
        await refresh(client, ['memory', claudeProject]);
      }}
      onDone={() => {
        go(target(project, claudeProject, parentOf(file)));
      }}
    />
  );
}

function NoteView({ project, claudeProject, file }: { project: string; claudeProject: string; file: string }): ReactNode {
  const { data, error } = useMemoryFileQuery(claudeProject, file);
  const listing = useMemoryQuery(claudeProject);
  const changed = listing.data?.files.find((f) => f.name === file)?.modifiedAt ?? '';
  return (
    <Col gap={20}>
      <PageHeader title={noteTitle(file)} subtitle={changed === '' ? undefined : `Updated ${whenLabel(changed)}`} action={<DeleteNote project={project} claudeProject={claudeProject} file={file} />} />
      {error !== null ? (
        <StateBlock icon="exclamationCircle" danger title="Could not read the note" text={queryError(error, 'Try again in a moment.')} />
      ) : data === undefined ? (
        <Loading />
      ) : (
        <MarkdownBlock
          text={data}
          size={FONT_SIZE.md}
          lineHeight={NOTE_LINE}
          resolveLink={(href) => {
            const linked = noteLink(file, href);
            return linked === null ? null : routeHash(target(project, claudeProject, linked));
          }}
        />
      )}
    </Col>
  );
}

interface MemoryProps {
  project: string;
  claudeProject: string | null;
  file: string | null;
}

export function Memory({ project, claudeProject, file }: MemoryProps): ReactNode {
  const home = useHomeProject();
  const picked = claudeProject ?? home.project;
  useDocumentTitle(isFile(file) ? noteTitle(file) : 'Notes');
  if (picked === null) return home.loading ? <Loading /> : <StateBlock icon="documentText" title="No notes yet" text={NONE} />;
  return (
    <Col gap={8}>
      <Crumbs crumbs={memoryCrumbs(project, picked, file ?? '')} />
      {isFile(file) ? <NoteView project={project} claudeProject={picked} file={file} /> : <FolderView project={project} claudeProject={picked} path={file ?? ''} />}
    </Col>
  );
}
