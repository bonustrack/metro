import { type ReactNode } from 'react';
import { ListRow } from './ListRow.js';
import { SettingsGroup } from './SettingsSection.js';
import { routeHash } from '../route.js';
import { type Selection } from './selection.js';
import { type ClaudeProject } from '../api/claude.js';
import { useClaudeProjectsQuery } from '../api/queries.js';
import { whenLabel } from '../api/when.js';

const folderLabel = (p: ClaudeProject): string => p.cwd ?? p.id;

const detailOf = (p: ClaudeProject): string =>
  [`${String(p.sessions)} ${p.sessions === 1 ? 'conversation' : 'conversations'}`, p.lastActiveAt === null ? '' : whenLabel(p.lastActiveAt)].filter((x) => x !== '').join(' · ');

interface OtherFoldersProps {
  project: string;
  shown: string;
  onSelect: (selection: Selection) => void;
}

export function OtherFolders({ project, shown, onSelect }: OtherFoldersProps): ReactNode {
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
            onOpen={() => {
              onSelect(target);
            }}
          />
        );
      })}
    </SettingsGroup>
  );
}
