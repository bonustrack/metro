import { type ReactNode } from 'react';
import { ListRow } from './ListRow.js';
import { SettingsGroup } from './SettingsSection.js';
import { routeHash } from '@metro-labs/client/route';
import { type Selection } from '@metro-labs/client/selection';
import { type ClaudeProject } from '@metro-labs/client/api/claude';
import { useClaudeProjectsQuery } from '../lib/queries.js';
import { whenLabel } from '@metro-labs/client/api/when';

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
    <SettingsGroup title="Other folders" note="Conversations Claude Code started in other folders, such as ones copied from another computer.">
      {others.map((p) => {
        const target: Selection = { kind: 'sessions', project, claudeProject: p.id, id: null };
        return (
          <ListRow
            key={p.id}
            title={folderLabel(p)}
            detail={detailOf(p)}
            href={routeHash(target)}
          />
        );
      })}
    </SettingsGroup>
  );
}
