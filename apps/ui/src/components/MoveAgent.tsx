import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { SettingsSection } from './SettingsSection.js';
import { ConfirmModal } from './ConfirmModal.js';
import { enterOrganization } from '../auth/org-route.js';
import { type OrganizationRow } from '../api/auth.js';
import { moveBoxOwner, moveServer, serverLabel, type Server } from '../api/servers.js';
import { queryError, useOrganizationsQuery } from '../api/queries.js';
import { activeAccount } from '../auth/account.js';

function useMove(server: Server): { busy: boolean; error: string | null; run: (to: OrganizationRow) => void } {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (to: OrganizationRow): void => {
    setBusy(true);
    setError(null);
    moveBoxOwner(to.id)
      .then(() => moveServer(server.id, to.id))
      .then(() => enterOrganization(client, to.id))
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not move the agent.'));
        setBusy(false);
      });
  };
  return { busy, error, run };
}

function Targets({ server, rows }: { server: Server; rows: OrganizationRow[] }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [target, setTarget] = useState<OrganizationRow | null>(null);
  const move = useMove(server);
  if (rows.length === 0)
    return (
      <Text size="sm" role="secondary">
        You are an admin of no other organization.
      </Text>
    );
  return (
    <>
      <Row gap={8} wrap>
        {rows.map((row) => (
          <Button
            key={row.id}
            size="sm"
            color="secondary"
            dark={dark}
            label={`Move to ${row.name ?? row.id}`}
            disabled={move.busy}
            onPress={() => {
              setTarget(row);
            }}
          />
        ))}
      </Row>
      {move.error === null ? null : (
        <Text size="sm" role="danger">
          {move.error}
        </Text>
      )}
      <ConfirmModal
        open={target !== null}
        title={`Move ${serverLabel(server)}?`}
        lines={[
          `The machine and its row in your list move to ${target?.name ?? target?.id ?? ''}. Only members of that organization can open it afterwards.`,
          'The agent keeps running. Nothing on the machine changes except who may log in.',
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
  if (account?.role !== 'admin') return null;
  const others = (orgs.data ?? []).filter((o) => o.id !== account.organization && o.role === 'admin');
  return (
    <SettingsSection title="Move to another organization" note="Hands this agent over. You must be an admin of both.">
      <Targets server={server} rows={others} />
    </SettingsSection>
  );
}
