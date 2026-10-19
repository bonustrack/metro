import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createOrganization, type OrganizationRow } from '@metro-labs/client/api/auth';
import { enterOrganization, isCurrentOrganization, routedOrganization } from '@metro-labs/client/auth/org-route';
import { namedSegment } from '@metro-labs/client/auth/org-segment';
import { location } from '@metro-labs/client/platform';
import { activeAccount } from '@metro-labs/client/auth/account';
import { NameModal } from './NameModal.js';
import { type MenuItem } from './Dropdown.js';
import { OrgMark } from './ui/OrgMark.js';
import { useOrganizationsQuery } from '../lib/queries.js';
import { prefetchOrganization } from '../lib/organization.js';

const MENU_MARK = 20;

function switchingTo(rows: OrganizationRow[]): OrganizationRow | undefined {
  const routed = routedOrganization();
  if (routed === null || isCurrentOrganization(routed)) return undefined;
  return rows.find((row) => row.id === routed || row.slug === routed);
}

const rowName = (row: OrganizationRow): string => row.name ?? row.slug ?? row.id;

const avatarOf = (rows: OrganizationRow[], id: string | null): string | null => rows.find((row) => row.id === id)?.avatar ?? null;

function organizationItems(rows: OrganizationRow[], shown: string | null, enter: (row: OrganizationRow) => void, create: () => void): MenuItem[] {
  return [
    ...rows.map((row) => ({
      label: rowName(row),
      leading: <OrgMark name={rowName(row)} src={row.avatar} size={MENU_MARK} />,
      selected: row.id === shown,
      onSelect: () => { enter(row); },
    })),
    { label: 'New organization', icon: 'plus' as const, separated: rows.length > 0, onSelect: create },
  ];
}

export interface OrganizationMenu {
  name: string;
  avatar: string | null;
  items: MenuItem[];
  modal: ReactNode;
}

export function useOrganizationMenu(onNavigate: () => void): OrganizationMenu {
  const client = useQueryClient();
  const rows = useOrganizationsQuery().data ?? [];
  const [creating, setCreating] = useState(false);
  const account = activeAccount();
  const switching = switchingTo(rows);
  const shown = switching?.id ?? account?.organization ?? null;
  const enter = (row: OrganizationRow): void => {
    onNavigate();
    if (row.id !== shown) location().push(`#/${namedSegment(row.id, row.slug)}`);
  };
  const items = organizationItems(rows, shown, enter, () => { setCreating(true); });
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
  return { name: switching?.name ?? account?.organizationName ?? 'Organization', avatar: avatarOf(rows, shown), items, modal };
}
