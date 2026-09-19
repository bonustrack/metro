import { type ReactNode, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Row } from '@stage-labs/kit/react-native/box';
import { Icon } from '@stage-labs/kit/react-native/icon';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui.js';
import { SHRINK } from '../theme.js';
import { Dropdown, type MenuItem } from './Dropdown.js';
import { NAV_ICON_SIZE, NAV_ROW_BOX } from './NavRow.js';
import { fetchOrganizations, type OrganizationRow } from '../api/auth.js';
import { enterOrganization } from '../auth/org-route.js';
import { activeAccount } from '../auth/account.js';
import { type Selection } from './selection.js';

function organizationItems(rows: OrganizationRow[], current: string | null, onPick: (id: string) => void): MenuItem[] {
  return rows.map((row) => ({
    label: row.name ?? row.id,
    ...(row.id === current ? { icon: 'check' as const } : {}),
    onSelect: () => {
      if (row.id !== current) onPick(row.id);
    },
  }));
}

export function OrganizationSwitcher({ onSelect }: { onSelect: (s: Selection) => void }): ReactNode {
  const palette = useKitPalette();
  const client = useQueryClient();
  const account = activeAccount();
  const [busy, setBusy] = useState(false);
  const { data } = useQuery({ queryKey: ['organizations'], queryFn: fetchOrganizations, staleTime: 30_000 });
  const current = account?.organization ?? null;
  const pick = (id: string): void => {
    if (busy) return;
    setBusy(true);
    enterOrganization(client, id)
      .catch(() => undefined)
      .finally(() => {
        setBusy(false);
      });
  };
  const items: MenuItem[] = [
    ...organizationItems(data ?? [], current, pick),
    {
      label: 'New organization',
      icon: 'plus',
      onSelect: () => {
        onSelect({ kind: 'organization' });
      },
    },
  ];
  return (
    <Dropdown className="account-trigger" label="Switch organization" align="start" items={items}>
      <Row {...NAV_ROW_BOX}>
        <Text size="md" weight="semibold" numberOfLines={1} style={SHRINK}>
          {account?.organizationName ?? 'Organization'}
        </Text>
        <Icon name="selector" size={NAV_ICON_SIZE} color={palette.sub} />
      </Row>
    </Dropdown>
  );
}
