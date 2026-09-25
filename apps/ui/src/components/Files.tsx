import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from './ui.js';
import { Crumbs, EntryRow, type Crumb } from './FolderBrowser.js';
import { Loading } from './Loading.js';
import { PageTitle } from './PageTitle.js';
import { SettingsGroup } from './SettingsSection.js';
import { routeHash } from '../route.js';
import { type Selection } from './selection.js';
import { fetchAgentPath, joinPath, pathSegments, type AgentPath, type FileEntry } from '../api/files.js';
import { queryError, useBoxQuery } from '../api/queries.js';
import { sizeLabel, whenLabel } from '../api/when.js';
import { useDocumentTitle } from '../title.js';

interface FilesProps {
  project: string;
  path: string;
  onSelect: (selection: Selection) => void;
}

const EMPTY = 'This folder is empty.';
const INTRO = "The agent's own folder, read with the agent's rights: only what the agent itself can open. Metro's files and the channel credentials are not here.";

function crumbsOf(project: string, root: string, path: string, onSelect: (s: Selection) => void): Crumb[] {
  const parts = pathSegments(path);
  return [root, ...parts].map((label, at) => {
    const target: Selection = { kind: 'files', project, path: parts.slice(0, at).join('/') };
    return { label, href: routeHash(target), onPress: () => { onSelect(target); } };
  });
}

const detailOf = (entry: FileEntry): string => {
  const when = entry.modifiedAt === '' ? '' : whenLabel(entry.modifiedAt);
  if (entry.kind === 'folder') return when === '' ? 'Folder' : `Folder · ${when}`;
  if (entry.kind === 'other') return 'Link or special file';
  return when === '' ? sizeLabel(entry.bytes) : `${sizeLabel(entry.bytes)} · ${when}`;
};

function FolderList({ project, answer, onSelect }: { project: string; answer: Extract<AgentPath, { kind: 'folder' }>; onSelect: (s: Selection) => void }): ReactNode {
  if (answer.entries.length === 0) return <Text size="sm" role="secondary">{EMPTY}</Text>;
  return (
    <SettingsGroup>
      {answer.entries.map((entry) => {
        const target: Selection = { kind: 'files', project, path: joinPath(answer.path.replace(/^\/+|\/+$/g, ''), entry.name) };
        return (
          <EntryRow
            key={entry.name}
            name={entry.name}
            detail={detailOf(entry)}
            folder={entry.kind === 'folder'}
            href={routeHash(target)}
            onOpen={() => { onSelect(target); }}
          />
        );
      })}
      {answer.more ? (
        <div className="settings-pad">
          <Text size="sm" role="secondary">Only the first 2,000 entries are shown.</Text>
        </div>
      ) : null}
    </SettingsGroup>
  );
}

function FileView({ answer }: { answer: Extract<AgentPath, { kind: 'file' }> }): ReactNode {
  const facts = `${sizeLabel(answer.bytes)}${answer.modifiedAt === '' ? '' : ` · changed ${whenLabel(answer.modifiedAt)}`}`;
  return (
    <Col gap={12}>
      <Text size="sm" role="secondary">{facts}</Text>
      {answer.text === null ? (
        <Text size="sm" role="secondary">This file is not text, so it cannot be shown here.</Text>
      ) : (
        <pre className="job-block file-block">{answer.text}</pre>
      )}
      {answer.truncated ? <Text size="sm" role="secondary">Only the first 256 KB are shown.</Text> : null}
    </Col>
  );
}

function FilesBody({ project, path, onSelect }: FilesProps): ReactNode {
  const query = useBoxQuery(['agent-files', path], () => fetchAgentPath(path), { staleTime: 5_000, retry: false });
  if (query.error !== null) return <Text size="sm" role="danger">{queryError(query.error, 'Could not read that path.')}</Text>;
  if (query.data === undefined) return <Loading />;
  return (
    <Col gap={16}>
      <Crumbs crumbs={crumbsOf(project, query.data.root === '' ? 'Agent folder' : query.data.root, path, onSelect)} />
      {query.data.kind === 'folder' ? <FolderList project={project} answer={query.data} onSelect={onSelect} /> : <FileView answer={query.data} />}
    </Col>
  );
}

export function Files({ project, path, onSelect }: FilesProps): ReactNode {
  useDocumentTitle('Files');
  return (
    <Col gap={16}>
      <PageTitle>Files</PageTitle>
      <Text size="sm" role="secondary">{INTRO}</Text>
      <FilesBody project={project} path={path} onSelect={onSelect} />
    </Col>
  );
}
