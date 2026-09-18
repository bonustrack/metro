import { type ReactNode, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { Pill } from './Pill.js';
import { Loading } from './Loading.js';
import { fetchOrganizations, switchOrganization, type OrganizationRow } from '../api/auth.js';
import { queryError } from '../api/queries.js';
import { activeAccount } from '../auth/account.js';

const ROW_PAD_Y = 10;

export function restartOn(hash: string): void {
  window.location.hash = hash;
  window.location.reload();
}

function OrganizationRowView({ row, current, onSwitch, busy }: { row: OrganizationRow; current: boolean; onSwitch: () => void; busy: boolean }): ReactNode {
  const palette = useKitPalette();
  const dark = useKitScheme() === 'dark';
  return (
    <Row align="center" gap={12} padding={{ y: ROW_PAD_Y }} border={{ bottom: { width: 1, color: palette.border } }}>
      <Row gap={10} align="center" flex={1} minWidth={0}>
        <Text size="md" weight="semibold" numberOfLines={1}>
          {row.name ?? row.id}
        </Text>
        {row.role === null ? null : (
          <Text size="sm" role="secondary">
            {row.role}
          </Text>
        )}
      </Row>
      {current ? <Pill label="Current" variant="primary" /> : <Button size="sm" color="secondary" dark={dark} label="Switch" disabled={busy} onPress={onSwitch} />}
    </Row>
  );
}

export function OrganizationList(): ReactNode {
  const { data, error } = useQuery({ queryKey: ['organizations'], queryFn: fetchOrganizations, staleTime: 30_000 });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const current = activeAccount()?.organization ?? null;
  const go = (id: string): void => {
    setBusy(true);
    setFailed(null);
    switchOrganization(id)
      .then(() => {
        restartOn('#/');
      })
      .catch((err: unknown) => {
        setFailed(queryError(err, 'Could not switch organization.'));
        setBusy(false);
      });
  };
  if (error !== null)
    return (
      <Text size="sm" role="danger">
        {queryError(error, 'Could not list your organizations.')}
      </Text>
    );
  if (data === undefined) return <Loading />;
  return (
    <Col gap={8}>
      <Text weight="semibold">Your organizations</Text>
      <Col>
        {data.map((row) => (
          <OrganizationRowView
            key={row.id}
            row={row}
            current={row.id === current}
            busy={busy}
            onSwitch={() => {
              go(row.id);
            }}
          />
        ))}
      </Col>
      {failed === null ? null : (
        <Text size="sm" role="danger">
          {failed}
        </Text>
      )}
    </Col>
  );
}
