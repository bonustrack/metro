import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ConfirmModal } from './ConfirmModal.js';
import { KebabMenu } from './KebabMenu.js';
import { deleteMemoryFile } from '../api/claude.js';
import { queryError, refreshMemory } from '../api/queries.js';

interface MemoryMenuProps {
  claudeProject: string;
  name: string;
  onDeleted?: () => void;
}

export function MemoryMenu({ claudeProject, name, onDeleted }: MemoryMenuProps): ReactNode {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const confirm = (): void => {
    if (busy) return;
    setBusy(true);
    setFailed(null);
    deleteMemoryFile(claudeProject, name)
      .then(() => refreshMemory(client, claudeProject))
      .then(() => {
        setOpen(false);
        onDeleted?.();
      })
      .catch((err: unknown) => {
        setFailed(queryError(err, 'Could not delete the memory.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <>
      <KebabMenu
        label={`Actions for ${name}`}
        size="lg"
        items={[
          {
            label: 'Delete memory',
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
        title="Delete this memory?"
        lines={[`“${name}” is removed from this machine. Claude writes a new one if it learns the same thing again.`]}
        prompt="Type delete to confirm."
        confirmWord="delete"
        confirmLabel="Delete memory"
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
