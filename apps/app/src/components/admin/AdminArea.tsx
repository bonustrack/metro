import { type ReactNode } from 'react';
import { activeAccount } from '@metro-labs/client/auth/account';
import { isOperator } from '@metro-labs/client/api/admin';
import { AppShell } from '../shell/AppShell.js';
import { Jump } from '../jump/Jump.js';
import { StateBlock } from '../ui/StateBlock.js';
import { AdminAgents } from './AdminAgents.js';
import { AdminOrganizations } from './AdminOrganizations.js';
import { AdminOverview } from './AdminOverview.js';
import { AdminPane } from './AdminPane.js';
import { AdminUsers } from './AdminUsers.js';
import { OrganizationPage } from './OrganizationPage.js';
import { UserPage } from './UserPage.js';
import { useIsNarrow } from '../../lib/media.js';
import type { AdminSelection } from '../../lib/shell-sections.js';

const FLUID = new Set<AdminSelection['kind']>(['admin-agents', 'admin-users', 'admin-organizations']);

function AdminPage({ selection }: { selection: AdminSelection }): ReactNode {
  if (selection.kind === 'admin-agents') return <AdminAgents />;
  if (selection.kind === 'admin-users') return <AdminUsers />;
  if (selection.kind === 'admin-user') return <UserPage key={selection.id} id={selection.id} />;
  if (selection.kind === 'admin-organizations') return <AdminOrganizations />;
  if (selection.kind === 'admin-organization') return <OrganizationPage key={selection.id} id={selection.id} />;
  return <AdminOverview />;
}

export function AdminArea({ selection, onLock }: { selection: AdminSelection; onLock: () => void }): ReactNode {
  const narrow = useIsNarrow();
  const operator = isOperator(activeAccount());
  return (
    <>
      <AppShell selection={selection} onLock={onLock} list={narrow || !operator ? null : <AdminPane selection={selection} />} fluid={FLUID.has(selection.kind)}>
        {operator ? <AdminPage selection={selection} /> : <StateBlock icon="shield" title="This page is for the Metro operator" text="Sign in with the operator account to see every agent, user and organization." />}
      </AppShell>
      <Jump />
    </>
  );
}
