import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { type OrganizationRow } from '@metro-labs/client/api/auth';
import { moveBoxOwner, moveServer, removeServer, serverLabel, type Server } from '@metro-labs/client/api/servers';
import { activeAccount } from '@metro-labs/client/auth/account';
import { enterOrganization } from '@metro-labs/client/auth/org-route';
import { ConfirmModal } from '../ConfirmModal.js';
import { ConfirmDialog, useConfirm } from '../DeleteMenu.js';
import { canDeleteServer, DeleteServerRow } from '../DeleteServer.js';
import { Group } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { PickDialog } from './PickDialog.js';
import { prefetchOrganization } from '../../lib/organization.js';
import { queryError, refreshServers, useOrganizationsQuery } from '../../lib/queries.js';
import { go } from '../../lib/nav.js';

function useMoveTargets(): OrganizationRow[] {
  const account = activeAccount();
  const orgs = useOrganizationsQuery().data ?? [];
  if (account?.role !== 'admin') return [];
  return orgs.filter((o) => o.id !== account.organization && o.role === 'admin');
}

function MoveRow({ server, targets }: { server: Server; targets: OrganizationRow[] }): ReactNode {
  const client = useQueryClient();
  const [picking, setPicking] = useState(false);
  const [target, setTarget] = useState<OrganizationRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const move = (to: OrganizationRow): void => {
    setBusy(true);
    setError(null);
    moveBoxOwner(to.id)
      .then(() => moveServer(server.id, to.id))
      .then(() => enterOrganization(to.id, prefetchOrganization(client)))
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not move the agent.'));
        setBusy(false);
      });
  };
  const nameOf = (row: OrganizationRow): string => row.name ?? row.slug ?? row.id;
  return (
    <>
      <Item
        title="Move to another organization"
        subtitle={error ?? undefined}
        subtitleTone="danger"
        onPress={() => {
          setPicking(true);
        }}
      />
      <PickDialog
        open={picking}
        title="Move to another organization"
        note="Hands this agent over. You must be an admin of both."
        options={targets.map((row) => ({ title: nameOf(row), onPick: () => { setTarget(row); } }))}
        onClose={() => {
          setPicking(false);
        }}
      />
      <ConfirmModal
        open={target !== null}
        title={`Move ${serverLabel(server)}?`}
        lines={[`The agent moves to ${target === null ? '' : nameOf(target)}. Only members there can open it after.`, 'The agent keeps running. Only who can open it changes.']}
        confirmWord="move"
        confirmLabel="Move agent"
        busy={busy}
        error={error}
        onClose={() => {
          if (!busy) setTarget(null);
        }}
        onConfirm={() => {
          if (target !== null) move(target);
        }}
      />
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

export function RemoveDialog({ server, confirming }: { server: Server; confirming: ReturnType<typeof useConfirm> }): ReactNode {
  return <ConfirmDialog confirming={confirming} title="Remove this agent?" lines={[`${serverLabel(server)} leaves your list. The server keeps running and nothing on it is deleted.`]} action="Remove agent" />;
}

function RemoveRow({ server }: { server: Server }): ReactNode {
  const removing = useRemoveFromList(server);
  return (
    <>
      <Item title={`Remove ${serverLabel(server)} from the list`} subtitle="The server keeps running. Nothing on it is deleted." danger chevron={false} onPress={removing.show} />
      <RemoveDialog server={server} confirming={removing} />
    </>
  );
}

export function DangerGroup({ server }: { server: Server }): ReactNode {
  const targets = useMoveTargets();
  return (
    <Group label="Danger">
      {targets.length === 0 ? null : <MoveRow server={server} targets={targets} />}
      {canDeleteServer(server) ? <DeleteServerRow server={server} /> : null}
      <RemoveRow server={server} />
    </Group>
  );
}
