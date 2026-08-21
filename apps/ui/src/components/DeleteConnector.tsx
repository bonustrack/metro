import { type ReactNode, useState } from 'react';
import { type Connector } from '../api/connectors';
import { ConfirmModal } from './ConfirmModal';
import { type MenuItem } from './Dropdown';
import { KebabMenu } from './KebabMenu';

interface DeleteConnectorProps {
  connector: Connector;
  onDelete: (id: string) => Promise<void>;
  size?: 'sm' | 'lg';
  extra?: MenuItem[];
}

export function DeleteConnector({
  connector,
  onDelete,
  size,
  extra = [],
}: DeleteConnectorProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = (): void => {
    setBusy(true);
    setError(null);
    onDelete(connector.id).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Could not delete the connector.');
      setBusy(false);
    });
  };

  return (
    <>
      <KebabMenu
        label="Connector actions"
        size={size}
        items={[
          ...extra,
          {
            label: 'Remove',
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
        title="Remove"
        lines={[
          'This removes the bookmark and the credential Metro stores for it. A config you have already pasted into an MCP client keeps working — Metro is only the holder.',
          'This cannot be undone. Adding it again means pasting the URL and the credential once more.',
        ]}
        prompt={`Type ${connector.name} to confirm.`}
        confirmWord={connector.name}
        confirmLabel="Remove"
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
