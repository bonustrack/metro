import { type ReactNode, useState } from 'react';
import { StyleSheet } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from '@stage-labs/kit/react-native/text';
import { createOrganization, type OrganizationRow } from '@metro-labs/client/api/auth';
import { enterOrganization, isCurrentOrganization, routedOrganization } from '@metro-labs/client/auth/org-route';
import { namedSegment } from '@metro-labs/client/auth/org-segment';
import { location } from '@metro-labs/client/platform';
import { activeAccount } from '@metro-labs/client/auth/account';
import { Icon } from './Icon.js';
import { NameModal } from './NameModal.js';
import { Dropdown, type MenuItem } from './Dropdown.js';
import { useOrganizationsQuery } from '../lib/queries.js';
import { prefetchOrganization } from '../lib/organization.js';
import { SHRINK } from '../lib/style.js';

const CHEVRON = 18;

const styles = StyleSheet.create({
  trigger: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 8 },
});

function switchingTo(rows: OrganizationRow[] | undefined): OrganizationRow | undefined {
  const routed = routedOrganization();
  if (routed === null || isCurrentOrganization(routed)) return undefined;
  return rows?.find((row) => row.id === routed || row.slug === routed);
}

export interface OrganizationMenu {
  name: string;
  items: MenuItem[];
  modal: ReactNode;
}

export function useOrganizationMenu(onNavigate: () => void): OrganizationMenu {
  const client = useQueryClient();
  const orgs = useOrganizationsQuery();
  const [creating, setCreating] = useState(false);
  const account = activeAccount();
  const current = account?.organization ?? null;
  const switching = switchingTo(orgs.data);
  const enter = (row: OrganizationRow): void => {
    onNavigate();
    if (row.id !== current) location().push(`#/${namedSegment(row.id, row.slug)}`);
  };
  const items: MenuItem[] = [
    ...(orgs.data ?? []).map((row) => ({ label: row.name ?? row.slug ?? row.id, selected: row.id === (switching?.id ?? current), onSelect: () => { enter(row); } })),
    { label: 'New organization', icon: 'plus' as const, separated: (orgs.data ?? []).length > 0, onSelect: () => { setCreating(true); } },
  ];
  const modal = (
    <NameModal
      title="New organization"
      action="Create"
      placeholder="Acme"
      failure="Could not create the organization."
      open={creating}
      onClose={() => {
        setCreating(false);
      }}
      onSubmit={async (made) => {
        const created = await createOrganization(made);
        if (created.organization !== null) await enterOrganization(created.organization, prefetchOrganization(client));
        onNavigate();
        return made;
      }}
    />
  );
  return { name: switching?.name ?? account?.organizationName ?? 'Organization', items, modal };
}

export function OrganizationSwitcher({ onNavigate }: { onNavigate: () => void }): ReactNode {
  const palette = useKitPalette();
  const menu = useOrganizationMenu(onNavigate);
  const fill = [styles.trigger, { backgroundColor: palette.border }];
  const hover = { backgroundColor: palette.inputBg };
  return (
    <>
      <Dropdown items={menu.items} label="Switch organization" align="start" matchWidth style={fill} hoverStyle={hover}>
        <Text size="md" weight="semibold" numberOfLines={1} style={SHRINK}>
          {menu.name}
        </Text>
        <Icon name="selector" size={CHEVRON} color={palette.sub} />
      </Dropdown>
      {menu.modal}
    </>
  );
}
