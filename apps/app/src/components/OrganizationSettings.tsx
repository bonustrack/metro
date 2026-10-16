import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { activeAccount } from '@metro-labs/client/auth/account';
import { refreshAccount } from '@metro-labs/client/api/auth';
import { renameOrganization, setOrganizationSlug } from '@metro-labs/client/api/organization';
import { noteRoutedOrganization } from '@metro-labs/client/auth/org-route';
import { routeHash } from '@metro-labs/client/route';
import { SLUG_RE } from '@metro-labs/client/auth/org-segment';
import { location } from '@metro-labs/client/platform';
import { NameModal } from './NameModal.js';
import { Group } from './ui/Group.js';
import { Item } from './ui/Item.js';
import { orgKey } from '../lib/queries.js';

const NAME_MIN = 2;
const NAME_MAX = 64;

type Editing = 'name' | 'slug' | null;

async function rename(name: string): Promise<void> {
  if (name.length < NAME_MIN || name.length > NAME_MAX) throw new Error(`Use ${String(NAME_MIN)} to ${String(NAME_MAX)} characters.`);
  await renameOrganization(name);
  await refreshAccount();
}

async function moveSlug(raw: string): Promise<void> {
  const slug = raw.trim().toLowerCase();
  if (!SLUG_RE.test(slug)) throw new Error('Use lowercase letters, digits and dashes.');
  await setOrganizationSlug(slug);
  await refreshAccount();
  noteRoutedOrganization(null);
  location().replace(routeHash({ kind: 'organization' }));
}

export function OrganizationSettings(): ReactNode {
  const client = useQueryClient();
  const [editing, setEditing] = useState<Editing>(null);
  const account = activeAccount();
  if (account === null || account.organization === null) return null;
  const admin = account.role === 'admin';
  const name = account.organizationName ?? '';
  const slug = account.organizationSlug ?? '';
  const open = (what: Editing) => (admin ? () => { setEditing(what); } : undefined);
  return (
    <Group label="Profile" note={admin ? undefined : 'Only an admin can change the name and the web address.'}>
      <Item title="Name" value={name} onPress={open('name')} />
      <Item title="Web address" value={`metro.box/${routeHash({ kind: 'servers' })}`} onPress={open('slug')} />
      <NameModal key={`name:${name}`} title="Rename the organization" action="Save" placeholder="Anderra" initial={name} failure="Could not rename the organization." open={editing === 'name'}
        onClose={() => { setEditing(null); }} onSubmit={async (next) => { await rename(next); await client.invalidateQueries({ queryKey: orgKey('organization') }); }} />
      <NameModal key={`slug:${slug}`} title="Change the web address" field="Web address" action="Save" placeholder="anderra" initial={slug} failure="Could not change the web address." open={editing === 'slug'}
        onClose={() => { setEditing(null); }} onSubmit={moveSlug} />
    </Group>
  );
}
