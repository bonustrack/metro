import { type ReactNode } from 'react';
import { routeHash } from '@metro-labs/client/route';
import { type ClaudeProject } from '@metro-labs/client/api/claude';
import { whenLabel } from '@metro-labs/client/api/when';
import { Group } from './ui/Group.js';
import { Item } from './ui/Item.js';
import { useClaudeProjectsQuery } from '../lib/queries.js';

const folderLabel = (p: ClaudeProject): string => p.cwd ?? p.id;

const detailOf = (p: ClaudeProject): string =>
  [`${String(p.sessions)} ${p.sessions === 1 ? 'conversation' : 'conversations'}`, p.lastActiveAt === null ? '' : whenLabel(p.lastActiveAt)].filter((x) => x !== '').join(' · ');

export function OtherFolders({ project, shown }: { project: string; shown: string }): ReactNode {
  const { data } = useClaudeProjectsQuery();
  const others = (data ?? [])
    .filter((p) => p.id !== shown && p.sessions > 0)
    .sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''));
  if (others.length === 0) return null;
  return (
    <Group label="Other folders" note="Conversations started in other folders, such as ones copied from another computer.">
      {others.map((p) => (
        <Item key={p.id} title={folderLabel(p)} subtitle={detailOf(p)} href={routeHash({ kind: 'sessions', project, claudeProject: p.id, id: null })} />
      ))}
    </Group>
  );
}
