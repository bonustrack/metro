import { type ReactNode } from 'react';
import { activeAccount } from '@metro-labs/client/auth/account';
import { InviteButton, MembersGroups } from './Members.js';
import { OrganizationAws } from './OrganizationAws.js';
import { OrganizationSettings } from './OrganizationSettings.js';
import { Groups } from './ui/Group.js';
import { OrgMark } from './ui/OrgMark.js';
import { PageHeader } from './ui/PageHeader.js';
import { AVATAR_SIZE } from './ui/sizes.js';
import { useOrganizationAvatar } from '../lib/queries.js';
import { useDocumentTitle } from '../lib/title.js';

export function OrganizationGroups(): ReactNode {
  const organization = activeAccount()?.organization ?? null;
  return (
    <>
      <OrganizationSettings />
      <MembersGroups />
      {organization === null ? null : <OrganizationAws />}
    </>
  );
}

function OrganizationHeader(): ReactNode {
  const account = activeAccount();
  const organization = account?.organization ?? null;
  const avatar = useOrganizationAvatar(organization);
  const leading = organization === null ? undefined : <OrgMark name={account?.organizationName ?? 'Organization'} src={avatar} size={AVATAR_SIZE.header} />;
  return <PageHeader title="Organization" leading={leading} action={account?.role === 'admin' ? <InviteButton /> : undefined} />;
}

export function Organization(): ReactNode {
  useDocumentTitle('Organization');
  return (
    <Groups>
      <OrganizationHeader />
      <OrganizationGroups />
    </Groups>
  );
}
