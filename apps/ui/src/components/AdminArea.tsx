import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Frame } from './Frame.js';
import { FieldLabel } from './FieldLabel.js';
import { NAV_GAP, NavRow } from './NavRow.js';
import { AdminUsers } from './AdminUsers.js';
import { AdminOverview } from './AdminOverview.js';
import { AdminOrganizations, AdminAgents } from './AdminLists.js';
import { type Selection } from './selection.js';
import { routeHash } from '../route.js';

export type AdminSelection = { kind: 'admin' } | { kind: 'admin-users' } | { kind: 'admin-organizations' } | { kind: 'admin-agents' };

const ADMIN_KINDS = new Set<Selection['kind']>(['admin', 'admin-users', 'admin-organizations', 'admin-agents']);

export const isAdminSelection = (s: Selection): s is AdminSelection => ADMIN_KINDS.has(s.kind);

function AdminSidebar({ selection, onSelect }: { selection: AdminSelection; onSelect: (next: Selection) => void }): ReactNode {
  return (
    <Col flex={1} minHeight={0}>
      <Col gap={NAV_GAP} padding={{ x: 20, top: 16 }}>
        <Row padding={{ bottom: 2 }}>
          <FieldLabel>Admin</FieldLabel>
        </Row>
        <NavRow label="Overview" icon="chartBar" selected={selection.kind === 'admin'} target={{ kind: 'admin' }} onSelect={onSelect} />
        <NavRow label="Users" icon="users" selected={selection.kind === 'admin-users'} target={{ kind: 'admin-users' }} onSelect={onSelect} />
        <NavRow label="Organizations" icon="officeBuilding" selected={selection.kind === 'admin-organizations'} target={{ kind: 'admin-organizations' }} onSelect={onSelect} />
        <NavRow label="Agents" icon="server" selected={selection.kind === 'admin-agents'} target={{ kind: 'admin-agents' }} onSelect={onSelect} />
      </Col>
    </Col>
  );
}

function AdminPage({ selection }: { selection: AdminSelection }): ReactNode {
  if (selection.kind === 'admin-organizations') return <AdminOrganizations />;
  if (selection.kind === 'admin-agents') return <AdminAgents />;
  if (selection.kind === 'admin-users') return <AdminUsers />;
  return <AdminOverview />;
}

export function AdminArea({ selection, onLock }: { selection: AdminSelection; onLock: () => void }): ReactNode {
  return (
    <Frame
      sidebar={(closeMenu) => (
        <AdminSidebar
          selection={selection}
          onSelect={(next) => {
            closeMenu();
            window.location.hash = routeHash(next);
          }}
        />
      )}
      onLock={onLock}
    >
      <AdminPage selection={selection} />
    </Frame>
  );
}
