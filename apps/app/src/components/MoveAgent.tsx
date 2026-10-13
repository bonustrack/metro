import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { SettingsSection } from './SettingsSection.js';
import { ConfirmModal } from './ConfirmModal.js';
import { Dropdown } from './Dropdown.js';
import { enterOrganization } from '@metro-labs/client/auth/org-route';
import { prefetchOrganization } from '../lib/organization.js';
import { type OrganizationRow } from '@metro-labs/client/api/auth';
import { moveBoxOwner, moveServer, serverLabel, type Server } from '@metro-labs/client/api/servers';
import { queryError, useOrganizationsQuery } from '../lib/queries.js';
import { activeAccount } from '@metro-labs/client/auth/account';

function useMove(server: Server): { busy: boolean; error: string | null; run: (to: OrganizationRow) => void } {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (to: OrganizationRow): void => {
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
  return { busy, error, run };
}

function Targets({ server, rows }: { server: Server; rows: OrganizationRow[] }): ReactNode {
  const [target, setTarget] = useState<OrganizationRow | null>(null);
  const move = useMove(server);
  if (rows.length === 0)
    return (
      <Text size="md" role="secondary">
        You are an admin of no other organization.
      </Text>
    );
  return (
    <>
      <Row>
        <Dropdown
          label="Move to another organization"
          button={{ label: move.busy ? 'Moving…' : 'Move to…', color: 'secondary', size: 'md' }}
          items={rows.map((row) => ({ label: row.name ?? row.slug ?? row.id, onSelect: () => { if (!move.busy) setTarget(row); } }))}
        />
      </Row>
      {move.error === null ? null : (
        <Text size="md" role="danger">
          {move.error}
        </Text>
      )}
      <ConfirmModal
        open={target !== null}
        title={`Move ${serverLabel(server)}?`}
        lines={[
          `The agent moves to ${target?.name ?? target?.id ?? ''}. Only members there can open it after.`,
          'The agent keeps running. Only who can open it changes.',
        ]}
        confirmWord="move"
        confirmLabel="Move agent"
        busy={move.busy}
        error={null}
        onClose={() => {
          if (!move.busy) setTarget(null);
        }}
        onConfirm={() => {
          if (target !== null) move.run(target);
        }}
      />
    </>
  );
}

export function MoveSection({ server }: { server: Server }): ReactNode {
  const account = activeAccount();
  const orgs = useOrganizationsQuery();
  if (account?.role !== 'admin' || (orgs.data?.length ?? 0) < 2) return null;
  const others = (orgs.data ?? []).filter((o) => o.id !== account.organization && o.role === 'admin');
  return (
    <SettingsSection title="Move to another organization" note="Hands this agent over. You must be an admin of both.">
      <Targets server={server} rows={others} />
    </SettingsSection>
  );
}
