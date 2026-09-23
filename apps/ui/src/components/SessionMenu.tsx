import { type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { DeleteMenu } from './DeleteMenu.js';
import { removeClaudeSession } from '../api/queries.js';

interface SessionMenuProps {
  claudeProject: string;
  id: string;
  title: string;
  onDeleted: () => void;
}

export function SessionMenu({ claudeProject, id, title, onDeleted }: SessionMenuProps): ReactNode {
  const client = useQueryClient();
  return (
    <DeleteMenu
      label={`Actions for ${title}`}
      items={[
        {
          label: 'Copy id',
          onSelect: () => {
            navigator.clipboard.writeText(id).catch(() => undefined);
          },
        },
      ]}
      action="Delete session"
      title="Delete this session?"
      lines={[
        `“${title}” and everything Claude did in it are removed from this machine. If the session is still running, Claude keeps going, but nothing more is saved.`,
      ]}
      failure="Could not delete the session."
      run={() => removeClaudeSession(client, claudeProject, id)}
      onDone={onDeleted}
    />
  );
}
