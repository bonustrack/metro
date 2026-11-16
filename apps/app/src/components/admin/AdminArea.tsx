import { type ReactNode } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { AppShell } from '../shell/AppShell.js';
import { Jump } from '../jump/Jump.js';
import { StateBlock } from '../ui/StateBlock.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { AdminAgents } from './AdminAgents.js';
import { AdminOrganizations } from './AdminOrganizations.js';
import { AdminOverview } from './AdminOverview.js';
import { AdminPane } from './AdminPane.js';
import { AdminUsers } from './AdminUsers.js';
import { OrganizationPage } from './OrganizationPage.js';
import { UserPage } from './UserPage.js';
import { useIsNarrow } from '../../lib/media.js';
import { useOperator } from '../../lib/operator.js';
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
  const operator = useOperator();
  return (
    <>
      <AppShell selection={selection} onLock={onLock} list={narrow || operator !== true ? null : <AdminPane selection={selection} />} fluid={FLUID.has(selection.kind)}>
        {operator === null ? <Column><RowsSkeleton rows={3} /></Column> : null}
        {operator === true ? <AdminPage selection={selection} /> : null}
        {operator === false ? <StateBlock icon="shield" title="This page is for the Metro operator" text="Sign in with the operator account to see every agent, user and organization." /> : null}
      </AppShell>
      <Jump />
    </>
  );
}
