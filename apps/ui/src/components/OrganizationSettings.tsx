import { type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { SaveField, useSave, type Saving } from './SaveField.js';
import { SettingsGroup, SettingsSection } from './SettingsSection.js';
import { activeAccount, type Account } from '../auth/account.js';
import { refreshAccount } from '../api/auth.js';
import { renameOrganization, setOrganizationSlug } from '../api/organization.js';
import { noteRoutedOrganization } from '../auth/org-route.js';
import { routeHash } from '../route.js';
import { SLUG_RE } from '../auth/org-segment.js';
import { orgKey } from '../api/queries.js';

const NAME_MIN = 2;
const NAME_MAX = 64;

function useRename(account: Account): Saving {
  const client = useQueryClient();
  return useSave({
    initial: account.organizationName ?? '',
    valid: (name) => name.length >= NAME_MIN && name.length <= NAME_MAX,
    run: async (name) => {
      await renameOrganization(name);
      await refreshAccount();
      await client.invalidateQueries({ queryKey: orgKey('organization') });
    },
    failure: 'Could not rename the organization.',
  });
}

function useSlug(account: Account): Saving {
  return useSave({
    initial: account.organizationSlug ?? '',
    clean: (slug) => slug.trim().toLowerCase(),
    valid: (slug) => SLUG_RE.test(slug),
    run: async (slug) => {
      await setOrganizationSlug(slug);
      await refreshAccount();
      noteRoutedOrganization(null);
      window.history.replaceState(null, '', `${window.location.pathname}${routeHash({ kind: 'organization' })}`);
    },
    failure: 'Could not change the slug.',
  });
}

function SlugRow({ account }: { account: Account }): ReactNode {
  const slug = useSlug(account);
  const admin = account.role === 'admin';
  const note = admin ? `Used in every link: metro.box/#/${account.organizationSlug ?? '…'}. Lowercase letters, digits and dashes.` : 'Only an admin can change it.';
  return (
    <SettingsSection title="Web address" note={note}>
      <SaveField saving={slug} name="slug" editable={admin} />
    </SettingsSection>
  );
}

function NameRow({ account }: { account: Account }): ReactNode {
  const rename = useRename(account);
  const admin = account.role === 'admin';
  return (
    <SettingsSection title="Name" note={admin ? 'What every member sees, and what invitations say.' : 'Only an admin can rename it.'}>
      <SaveField saving={rename} name="organization" editable={admin} />
    </SettingsSection>
  );
}

export function OrganizationSettings(): ReactNode {
  const account = activeAccount();
  const organization = account?.organization ?? null;
  if (account === null || organization === null) return null;
  return (
    <SettingsGroup title="Profile">
      <NameRow account={account} />
      <SlugRow account={account} />
    </SettingsGroup>
  );
}
