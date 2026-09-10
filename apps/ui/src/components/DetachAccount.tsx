import { type ReactNode, useState } from 'react';
import { ConfirmModal } from './ConfirmModal.js';
import { KebabMenu } from './KebabMenu.js';

interface DetachAccountProps {
  station: string;
  accountId: string;
  onDetach: (station: string, accountId: string) => Promise<void>;
}

const RECONNECT_NOTES: Record<string, string> = {
  webhook:
    'This cannot be undone. Connecting it again mints a new URL and a new secret, so whoever posts to this one has to be updated.',
  threema:
    'This cannot be undone. Connecting it again mints a new callback URL, which has to be pasted into the Gateway ID settings again.',
};

export function DetachAccount({
  station,
  accountId,
  onDetach,
}: DetachAccountProps): ReactNode {
  const reconnectNote =
    RECONNECT_NOTES[station] ??
    'This cannot be undone. Connecting it again means going through the whole sign-in once more.';
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = (): void => {
    setBusy(true);
    setError(null);
    onDetach(station, accountId).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Could not delete the channel.');
      setBusy(false);
    });
  };

  return (
    <>
      <KebabMenu
        label="Channel actions"
        size="lg"
        items={[
          {
            label: 'Delete channel',
            danger: true,
            onSelect: () => {
              setError(null);
              setOpen(true);
            },
          },
        ]}
      />
      <ConfirmModal
        open={open}
        title="Delete channel"
        lines={[
          'This deletes the channel and the credentials Metro stores for it. It stops relaying immediately.',
          reconnectNote,
        ]}
        prompt={`Type ${accountId} to confirm.`}
        confirmWord={accountId}
        confirmLabel="Delete channel"
        busy={busy}
        error={error}
        onClose={() => {
          setOpen(false);
        }}
        onConfirm={remove}
      />
    </>
  );
}
