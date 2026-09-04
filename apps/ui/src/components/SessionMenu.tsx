import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ConfirmModal } from './ConfirmModal';
import { KebabMenu } from './KebabMenu';
import { queryError, removeClaudeSession } from '../api/queries';

interface SessionMenuProps {
  token: string;
  claudeProject: string;
  id: string;
  title: string;
  onDeleted: () => void;
}

export function SessionMenu({ token, claudeProject, id, title, onDeleted }: SessionMenuProps): ReactNode {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const confirm = (): void => {
    if (busy) return;
    setBusy(true);
    setFailed(null);
    removeClaudeSession(client, token, claudeProject, id)
      .then(() => {
        setOpen(false);
        onDeleted();
      })
      .catch((err: unknown) => {
        setFailed(queryError(err, 'Could not delete the session.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <>
      <KebabMenu
        label={`Actions for ${title}`}
        size="lg"
        items={[
          {
            label: 'Delete session',
            danger: true,
            onSelect: () => {
              setFailed(null);
              setOpen(true);
            },
          },
        ]}
      />
      <ConfirmModal
        open={open}
        title="Delete this session?"
        lines={[
          `“${title}” and everything Claude did in it are removed from this machine. If the session is still running, Claude keeps going, but nothing more is saved.`,
        ]}
        prompt="Type delete to confirm."
        confirmWord="delete"
        confirmLabel="Delete session"
        busy={busy}
        error={failed}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        onConfirm={confirm}
      />
    </>
  );
}
