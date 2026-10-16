import { type ReactNode } from 'react';
import { activeAccount } from '@metro-labs/client/auth/account';
import { InviteButton, MembersGroups } from './Members.js';
import { OrganizationAws } from './OrganizationAws.js';
import { OrganizationSettings } from './OrganizationSettings.js';
import { Groups } from './ui/Group.js';
import { PageHeader } from './ui/PageHeader.js';
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
  const admin = activeAccount()?.role === 'admin';
  return <PageHeader title="Organization" action={admin ? <InviteButton /> : undefined} />;
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
