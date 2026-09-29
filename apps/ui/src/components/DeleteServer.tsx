import { type ReactNode, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from './ui.js';
import { SettingsGroup, SettingsSection } from './SettingsSection.js';
import { ConfirmModal } from './ConfirmModal.js';
import { orgKey, queryError, refreshServers } from '../api/queries.js';
import { deleteServer, deletionLines, fetchDeletion, type Deletable, type DeletionView } from '../api/deletion.js';
import { serverLabel, type Server } from '../api/servers.js';
import { activeAccount } from '../auth/account.js';
import { routeHash } from '../route.js';

const NOTE = 'Terminates the server in AWS and deletes its disk, with the agent and everything on it.';
const READING = 'Reading what AWS holds for this server…';

const readyOf = (view: DeletionView | undefined): Deletable | null => (view?.deletable === true ? view : null);

const linesOf = (view: DeletionView | undefined): string[] => {
  if (view === undefined) return [READING];
  return view.deletable ? deletionLines(view) : [view.reason];
};

function DeleteDialog({ server, onClose }: { server: Server; onClose: () => void }): ReactNode {
  const client = useQueryClient();
  const preview = useQuery({ queryKey: orgKey('deletion', server.id), queryFn: () => fetchDeletion(server.id), staleTime: 0, gcTime: 0, retry: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = readyOf(preview.data);
  const run = (): void => {
    if (ready === null) return;
    setBusy(true);
    setError(null);
    deleteServer(server.id, ready, ready.name)
      .then(async () => {
        await refreshServers(client);
        window.location.hash = routeHash({ kind: 'servers' });
      })
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not delete the server.'));
        setBusy(false);
      });
  };
  const readError = preview.error === null ? null : queryError(preview.error, 'Could not read this server in AWS.');
  return (
    <ConfirmModal
      open
      title={`Delete ${serverLabel(server)}?`}
      lines={readError === null ? linesOf(preview.data) : []}
      confirmWord={ready?.name ?? serverLabel(server)}
      confirmLabel="Delete server"
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

export function DeleteServerSection({ server }: { server: Server }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [open, setOpen] = useState(false);
  if (server.instanceId === null || activeAccount()?.role !== 'admin') return null;
  return (
    <SettingsGroup title="Danger zone">
      <SettingsSection title="Delete this server" note={NOTE}>
        <Button
          size="sm"
          color="danger"
          dark={dark}
          label="Delete"
          onPress={() => {
            setOpen(true);
          }}
        />
        {open ? (
          <DeleteDialog
            server={server}
            onClose={() => {
              setOpen(false);
            }}
          />
        ) : null}
      </SettingsSection>
    </SettingsGroup>
  );
}
