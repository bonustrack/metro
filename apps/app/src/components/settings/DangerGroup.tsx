import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { type OrganizationRow } from '@metro-labs/client/api/auth';
import { moveBoxOwner, moveServer, removeServer, serverLabel, type Server } from '@metro-labs/client/api/servers';
import { activeAccount } from '@metro-labs/client/auth/account';
import { enterOrganization } from '@metro-labs/client/auth/org-route';
import { ConfirmModal } from '../ConfirmModal.js';
import { ConfirmDialog, useConfirm } from '../DeleteMenu.js';
import { canDeleteServer, DeleteServerRow } from '../DeleteServer.js';
import { Icon } from '../Icon.js';
import { Group, Rows } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { ICON_SIZE } from '../ui/sizes.js';
import { prefetchOrganization } from '../../lib/organization.js';
import { queryError, refreshServers, useOrganizationsQuery } from '../../lib/queries.js';
import { go } from '../../lib/nav.js';

const nameOf = (row: OrganizationRow): string => row.name ?? row.slug ?? row.id;

function useMoveTargets(): OrganizationRow[] {
  const account = activeAccount();
  const orgs = useOrganizationsQuery().data ?? [];
  if (account?.role !== 'admin') return [];
  return orgs.filter((o) => o.id !== account.organization && o.role === 'admin');
}

function Targets({ targets, picked, onPick }: { targets: OrganizationRow[]; picked: OrganizationRow | null; onPick: (row: OrganizationRow) => void }): ReactNode {
  const palette = useKitPalette();
  return (
    <Rows>
      {targets.map((row) => (
        <Item key={row.id} title={nameOf(row)} chevron={false} trailing={picked?.id === row.id ? <Icon name="check" size={ICON_SIZE.md} color={palette.link} /> : undefined} onPress={() => { onPick(row); }} />
      ))}
    </Rows>
  );
}

function MoveRow({ server, targets }: { server: Server; targets: OrganizationRow[] }): ReactNode {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<OrganizationRow | null>(targets.length === 1 ? (targets[0] ?? null) : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = serverLabel(server);
  const move = (): void => {
    if (target === null) return;
    setBusy(true);
    setError(null);
    moveBoxOwner(target.id)
      .then(() => moveServer(server.id, target.id))
      .then(() => enterOrganization(target.id, prefetchOrganization(client)))
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not move the agent.'));
        setBusy(false);
      });
  };
  return (
    <>
      <Item title="Move to another organization" subtitle="Only who can open it changes. It keeps running." onPress={() => { setError(null); setOpen(true); }} />
      <ConfirmModal
        open={open}
        title={`Move ${name}?`}
        lines={['Only members of the organization you pick can open it after.']}
        confirmWord={name}
        confirmLabel={`Move ${name}`}
        busy={busy}
        blocked={target === null}
        error={error}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        onConfirm={move}
      >
        <Targets targets={targets} picked={target} onPick={setTarget} />
      </ConfirmModal>
    </>
  );
}

export function useRemoveFromList(server: Server): ReturnType<typeof useConfirm> {
  const client = useQueryClient();
  return useConfirm(
    async () => {
      await removeServer(server.id);
      await refreshServers(client);
    },
    'Could not remove the agent.',
    () => {
      go({ kind: 'servers' });
    },
  );
}

const keepsRunning = (server: Server): string => (server.instanceId === null ? 'The server keeps running.' : 'The server keeps running in AWS.');

export function RemoveDialog({ server, confirming }: { server: Server; confirming: ReturnType<typeof useConfirm> }): ReactNode {
  const name = serverLabel(server);
  return <ConfirmDialog confirming={confirming} title={`Remove ${name} from Metro?`} lines={[`${name} leaves your list. ${keepsRunning(server)} Nothing on it is deleted.`]} action="Remove from Metro" word={name} />;
}

function RemoveRow({ server }: { server: Server }): ReactNode {
  const removing = useRemoveFromList(server);
  return (
    <>
      <Item title="Remove from Metro" subtitle={keepsRunning(server)} danger chevron={false} onPress={removing.show} />
      <RemoveDialog server={server} confirming={removing} />
    </>
  );
}

export function DangerGroup({ server }: { server: Server }): ReactNode {
  const targets = useMoveTargets();
  return (
    <Group label="Danger">
      {targets.length === 0 ? null : <MoveRow server={server} targets={targets} />}
      <RemoveRow server={server} />
      {canDeleteServer(server) ? <DeleteServerRow server={server} /> : null}
    </Group>
  );
}
