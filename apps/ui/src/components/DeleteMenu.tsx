import { type ReactNode, useState } from 'react';
import { ConfirmModal } from './ConfirmModal.js';
import { KebabMenu } from './KebabMenu.js';
import { type MenuItem } from './Dropdown.js';
import { DELETE_WORD } from './confirm.js';
import { queryError } from '../api/queries.js';

export interface Confirming {
  open: boolean;
  busy: boolean;
  error: string | null;
  show: () => void;
  close: () => void;
  confirm: () => void;
}

export function useConfirm(run: () => Promise<void>, failure: string, onDone?: () => void): Confirming {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    run()
      .then(() => {
        setOpen(false);
        onDone?.();
      })
      .catch((err: unknown) => {
        setError(queryError(err, failure));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return {
    open,
    busy,
    error,
    show: () => {
      setError(null);
      setOpen(true);
    },
    close: () => {
      if (!busy) setOpen(false);
    },
    confirm,
  };
}

interface ConfirmDialogProps {
  confirming: Confirming;
  title: string;
  lines: string[];
  action: string;
  word?: string;
}

export function ConfirmDialog({ confirming, title, lines, action, word = DELETE_WORD }: ConfirmDialogProps): ReactNode {
  return (
    <ConfirmModal
      open={confirming.open}
      title={title}
      lines={lines}
      confirmWord={word}
      confirmLabel={action}
      busy={confirming.busy}
      error={confirming.error}
      onClose={confirming.close}
      onConfirm={confirming.confirm}
    />
  );
}

interface DeleteMenuProps extends Omit<ConfirmDialogProps, 'confirming'> {
  label: string;
  item?: string;
  items?: MenuItem[];
  failure: string;
  run: () => Promise<void>;
  onDone?: () => void;
}

export function DeleteMenu({ label, item, items = [], failure, run, onDone, ...dialog }: DeleteMenuProps): ReactNode {
  const confirming = useConfirm(run, failure, onDone);
  return (
    <>
      <KebabMenu label={label} size="lg" items={[...items, { label: item ?? dialog.action, danger: true, onSelect: confirming.show }]} />
      <ConfirmDialog confirming={confirming} {...dialog} />
    </>
  );
}
