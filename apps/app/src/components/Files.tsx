import { type ReactNode } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { Text } from '@stage-labs/kit/react-native/text';
import { fetchAgentPath, joinPath, pathSegments, type AgentPath, type FileEntry } from '@metro-labs/client/api/files';
import { sizeLabel, whenLabel } from '@metro-labs/client/api/when';
import { routeHash } from '@metro-labs/client/route';
import { type Selection } from '@metro-labs/client/selection';
import { Crumbs, EntryRow, type Crumb } from './FolderBrowser.js';
import { Group, Groups } from './ui/Group.js';
import { LogBlock } from './ui/LogBlock.js';
import { PageHeader } from './ui/PageHeader.js';
import { ErrorState } from './ui/ErrorState.js';
import { RowsSkeleton } from './ui/RowsSkeleton.js';
import { StateBlock } from './ui/StateBlock.js';
import { useAgentName } from '../lib/agent-hooks.js';
import { queryError, useBoxQuery } from '../lib/queries.js';
import { useTechnicalDetails } from '../lib/technical.js';
import { useDocumentTitle } from '../lib/title.js';

interface FilesProps {
  project: string;
  path: string;
}

type FolderAnswer = Extract<AgentPath, { kind: 'folder' }>;
type FileAnswer = Extract<AgentPath, { kind: 'file' }>;

function crumbsOf(project: string, root: string, path: string): Crumb[] {
  const parts = pathSegments(path);
  return [root, ...parts].map((label, at) => {
    const target: Selection = { kind: 'files', project, path: parts.slice(0, at).join('/') };
    return { label, href: routeHash(target) };
  });
}

const detailOf = (entry: FileEntry): string => {
  const when = entry.modifiedAt === '' ? '' : whenLabel(entry.modifiedAt);
  if (entry.kind === 'folder') return when;
  if (entry.kind === 'other') return 'Link or special file';
  return when === '' ? sizeLabel(entry.bytes) : `${sizeLabel(entry.bytes)} · ${when}`;
};

function EntryGroup({ label, project, answer, entries, note }: { label: string; project: string; answer: FolderAnswer; entries: FileEntry[]; note?: string }): ReactNode {
  if (entries.length === 0) return null;
  const parent = answer.path.replace(/^\/+|\/+$/g, '');
  return (
    <Group label={label} note={note}>
      {entries.map((entry) => (
        <EntryRow key={entry.name} name={entry.name} detail={detailOf(entry)} folder={entry.kind === 'folder'} href={routeHash({ kind: 'files', project, path: joinPath(parent, entry.name) })} />
      ))}
    </Group>
  );
}

function FolderList({ project, answer }: { project: string; answer: FolderAnswer }): ReactNode {
  if (answer.entries.length === 0) return <StateBlock icon="folder" title="Empty folder" text="Nothing in here yet." />;
  const more = answer.more ? 'Only the first 2,000 entries are shown.' : undefined;
  const files = answer.entries.filter((entry) => entry.kind !== 'folder');
  return (
    <Groups>
      <EntryGroup label="Folders" project={project} answer={answer} entries={answer.entries.filter((entry) => entry.kind === 'folder')} note={files.length === 0 ? more : undefined} />
      <EntryGroup label="Files" project={project} answer={answer} entries={files} note={more} />
    </Groups>
  );
}

function FileView({ answer }: { answer: FileAnswer }): ReactNode {
  const facts = `${sizeLabel(answer.bytes)}${answer.modifiedAt === '' ? '' : ` · changed ${whenLabel(answer.modifiedAt)}`}`;
  return (
    <Column gap={16}>
      <PageHeader title={pathSegments(answer.path).pop() ?? answer.path} subtitle={facts} />
      {answer.text === null ? (
        <StateBlock icon="documentText" title="Not a text file" text="It cannot be shown here." />
      ) : (
        <LogBlock text={answer.text} maxHeight={null} />
      )}
      {answer.truncated ? <Text size="xs" color="secondary">Only the first 256 KB are shown.</Text> : null}
    </Column>
  );
}

function Intro({ path }: { path: string }): ReactNode {
  const name = useAgentName();
  if (path !== '') return null;
  return (
    <Text size="xs" color="secondary">
      {`${name}’s own folder, as ${name} sees it. Metro’s files and the chat keys are not here.`}
    </Text>
  );
}

export function Files({ project, path }: FilesProps): ReactNode {
  const technical = useTechnicalDetails();
  const query = useBoxQuery(['agent-files', path], () => fetchAgentPath(path), { staleTime: 5_000, retry: false });
  useDocumentTitle('Files');
  if (query.data === undefined)
    return query.error === null ? <RowsSkeleton rows={5} trailing={false} /> : <ErrorState title="Could not read that folder" text={queryError(query.error, 'The agent did not answer.')} onRetry={query.refetch} />;
  return (
    <Column gap={16}>
      <Intro path={path} />
      <Crumbs crumbs={crumbsOf(project, technical && query.data.root !== '' ? query.data.root : 'Agent folder', path)} />
      {query.data.kind === 'folder' ? <FolderList project={project} answer={query.data} /> : <FileView answer={query.data} />}
    </Column>
  );
}
