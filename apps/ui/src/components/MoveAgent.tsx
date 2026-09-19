import { type ReactNode, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { ConfirmModal } from './ConfirmModal.js';
import { restartOn } from './OrganizationList.js';
import { fetchOrganizations, type OrganizationRow } from '../api/auth.js';
import { moveBoxOwner, moveServer, serverLabel, type Server } from '../api/servers.js';
import { queryError, useModeQuery } from '../api/queries.js';
import { olderThan } from '../api/version.js';
import { activeAccount } from '../auth/account.js';

const MOVE_SINCE = '0.1.0-beta.139';

function Section({ title, note, children }: { title: string; note: string; children: ReactNode }): ReactNode {
  const palette = useKitPalette();
  return (
    <Col gap={12} padding={{ bottom: 20 }} border={{ bottom: { width: 1, color: palette.border } }}>
      <Col gap={2}>
        <Text weight="semibold">{title}</Text>
        <Text size="sm" role="secondary">
          {note}
        </Text>
      </Col>
      {children}
    </Col>
  );
}

function useMove(server: Server): { busy: boolean; error: string | null; run: (to: OrganizationRow) => void } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (to: OrganizationRow): void => {
    setBusy(true);
    setError(null);
    moveBoxOwner(to.id)
      .then(() => moveServer(server.id, to.id))
      .then(() => {
        restartOn('#/');
      })
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
        prompt="Type move to confirm."
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
  const mode = useModeQuery();
  const orgs = useQuery({ queryKey: ['organizations'], queryFn: fetchOrganizations, staleTime: 30_000 });
  if (account?.role !== 'admin') return null;
  const old = olderThan(mode.data?.version ?? null, MOVE_SINCE);
  const others = (orgs.data ?? []).filter((o) => o.id !== account.organization && o.role === 'admin');
  return (
    <Section title="Move to another organization" note="The machine and its row in your list change owner. You must be an admin of both organizations.">
      {old ? (
        <Text size="sm" role="secondary">
          {`Moving needs metro ${MOVE_SINCE} or newer on this machine. Update it from the Server page first.`}
        </Text>
      ) : (
        <Targets server={server} rows={others} />
      )}
    </Section>
  );
}
