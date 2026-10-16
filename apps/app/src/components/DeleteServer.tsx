import { type ReactNode, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Group } from './ui/Group.js';
import { Item } from './ui/Item.js';
import { ConfirmModal } from './ConfirmModal.js';
import { orgKey, queryError, refreshServers } from '../lib/queries.js';
import { deleteServer, deletionLines, fetchDeletion, type Deletable, type DeletionScope, type DeletionView } from '@metro-labs/client/api/deletion';
import { serverLabel, type Server } from '@metro-labs/client/api/servers';
import { activeAccount } from '@metro-labs/client/auth/account';
import { go } from '../lib/nav.js';

const NOTE = 'Stops and removes the server in AWS.';
const READING = 'Reading what AWS holds for this server…';

const readyOf = (view: DeletionView | undefined): Deletable | null => (view?.deletable === true ? view : null);

const linesOf = (view: DeletionView | undefined): string[] => {
  if (view === undefined) return [READING];
  return view.deletable ? deletionLines(view) : [view.reason];
};

interface DeleteDialogProps {
  id: string;
  label: string;
  scope: DeletionScope;
  onDeleted: () => Promise<void>;
  onClose: () => void;
}

export function DeleteDialog({ id, label, scope, onDeleted, onClose }: DeleteDialogProps): ReactNode {
  const key = scope === 'admin' ? ['admin', 'deletion', id] : orgKey('deletion', id);
  const preview = useQuery({ queryKey: key, queryFn: () => fetchDeletion(id, scope), staleTime: 0, gcTime: 0, retry: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = readyOf(preview.data);
  const run = (typed: string): void => {
    if (ready === null) return;
    setBusy(true);
    setError(null);
    deleteServer(id, ready, typed, scope)
      .then(onDeleted)
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not delete the server.'));
        setBusy(false);
      });
  };
  const readError = preview.error === null ? null : queryError(preview.error, 'Could not read this server in AWS.');
  return (
    <ConfirmModal
      open
      title={`Delete ${label}?`}
      lines={readError === null ? linesOf(preview.data) : []}
      confirmWord={ready?.name ?? label}
      confirmLabel={ready?.entryOnly === true ? 'Remove agent' : 'Delete server'}
      busy={busy}
      blocked={ready === null}
      error={error ?? readError}
      onClose={() => {
        if (!busy) onClose();
      }}
      onConfirm={run}
    />
  );
}

export function DeleteServerDialog({ server, onClose }: { server: Server; onClose: () => void }): ReactNode {
  const client = useQueryClient();
  return (
    <DeleteDialog
      id={server.id}
      label={serverLabel(server)}
      scope="organization"
      onDeleted={async () => {
        await refreshServers(client);
        go({ kind: 'servers' });
      }}
      onClose={onClose}
    />
  );
}

export const canDeleteServer = (server: Server): boolean => server.instanceId !== null && activeAccount()?.role === 'admin';

export function DeleteServerRow({ server }: { server: Server }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Item
        title={`Delete ${serverLabel(server)}`}
        subtitle={NOTE}
        danger
        chevron={false}
        onPress={() => {
          setOpen(true);
        }}
      />
      {open ? (
        <DeleteServerDialog
          server={server}
          onClose={() => {
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

export function DeleteServerSection({ server }: { server: Server }): ReactNode {
  if (!canDeleteServer(server)) return null;
  return (
    <Group label="Danger">
      <DeleteServerRow server={server} />
    </Group>
  );
}
