import { type ReactNode } from 'react';
import { activeAccount } from '@metro-labs/client/auth/account';
import { Groups } from './ui/Group.js';
import { PageHeader } from './ui/PageHeader.js';
import { useDocumentTitle } from '../lib/title.js';
import { AccountSettings } from './AccountSettings.js';

export function Settings(): ReactNode {
  useDocumentTitle('Settings');
  return (
    <Groups>
      <PageHeader title="Settings" subtitle={activeAccount()?.user.email ?? undefined} />
      <AccountSettings />
    </Groups>
  );
}
