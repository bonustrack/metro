import { type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from './ui.js';
import { SaveField, useSave, type Saving } from './SaveField.js';
import { activeAccount, type Account } from '../auth/account.js';
import { refreshAccount } from '../api/auth.js';
import { renameOrganization, setOrganizationSlug } from '../api/organization.js';
import { noteRoutedOrganization } from '../auth/org-route.js';
import { routeHash } from '../route.js';
import { SLUG_RE } from '../auth/org-segment.js';

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
      await client.invalidateQueries({ queryKey: ['organization'] });
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

function SlugBlock({ account }: { account: Account }): ReactNode {
  const slug = useSlug(account);
  const admin = account.role === 'admin';
  return (
    <Col gap={12}>
      <Col gap={2}>
        <Text weight="semibold">Slug</Text>
        <Text size="sm" role="secondary">
          {admin ? `The organization's part of every address: metro.box/#/${account.organizationSlug ?? '…'}. Lowercase letters, digits and dashes.` : 'Only an admin can change the slug.'}
        </Text>
      </Col>
      <SaveField saving={slug} name="slug" editable={admin} />
    </Col>
  );
}

function Block({ account }: { account: Account }): ReactNode {
  const rename = useRename(account);
  const admin = account.role === 'admin';
  return (
    <Col gap={12}>
      <Col gap={2}>
        <Text weight="semibold">Name</Text>
        <Text size="sm" role="secondary">
          {admin ? 'What every member sees, on this page and in the invitations Metro sends.' : 'Only an admin can rename the organization.'}
        </Text>
      </Col>
      <SaveField saving={rename} name="organization" editable={admin} />
    </Col>
  );
}

export function OrganizationSettings(): ReactNode {
  const account = activeAccount();
  const organization = account?.organization ?? null;
  if (account === null || organization === null) return null;
  return (
    <Col gap={24}>
      <Block account={account} />
      <SlugBlock account={account} />
    </Col>
  );
}
