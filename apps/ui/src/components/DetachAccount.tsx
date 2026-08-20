import { type ReactNode, useState } from 'react';
import { ConfirmModal } from './ConfirmModal';
import { KebabMenu } from './KebabMenu';

interface DetachAccountProps {
  station: string;
  accountId: string;
  onDetach: (station: string, accountId: string) => Promise<void>;
}

export function DetachAccount({
  station,
  accountId,
  onDetach,
}: DetachAccountProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = (): void => {
    setBusy(true);
    setError(null);
    onDetach(station, accountId).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Could not delete the station.');
      setBusy(false);
    });
  };

  return (
    <>
      <KebabMenu
        label="Station actions"
        items={[
          {
            label: 'Delete station',
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
        title="Delete station"
        lines={[
          'This deletes the station and the credentials Metro stores for it. It stops relaying immediately.',
          'This cannot be undone. Connecting it again means going through the whole sign-in once more.',
        ]}
        prompt={`Type ${accountId} to confirm.`}
        confirmWord={accountId}
        confirmLabel="Delete station"
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
