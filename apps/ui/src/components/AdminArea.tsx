import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Frame } from './Frame.js';
import { FieldLabel } from './FieldLabel.js';
import { NAV_GAP, NavRow } from './NavRow.js';
import { AdminUsers } from './AdminUsers.js';
import { AdminOrganizations, AdminAgents } from './AdminLists.js';
import { type Selection } from './selection.js';
import { routeHash } from '../route.js';

export type AdminSelection = { kind: 'admin' } | { kind: 'admin-organizations' } | { kind: 'admin-agents' };

export const isAdminSelection = (s: Selection): s is AdminSelection => s.kind === 'admin' || s.kind === 'admin-organizations' || s.kind === 'admin-agents';

function AdminSidebar({ selection, onSelect }: { selection: AdminSelection; onSelect: (next: Selection) => void }): ReactNode {
  return (
    <Col flex={1} minHeight={0}>
      <Col gap={NAV_GAP} padding={{ x: 24, top: 24 }}>
        <Row padding={{ bottom: 2 }}>
          <FieldLabel>Admin</FieldLabel>
        </Row>
        <NavRow label="Users" icon="users" selected={selection.kind === 'admin'} target={{ kind: 'admin' }} onSelect={onSelect} />
        <NavRow label="Organizations" icon="officeBuilding" selected={selection.kind === 'admin-organizations'} target={{ kind: 'admin-organizations' }} onSelect={onSelect} />
        <NavRow label="Agents" icon="server" selected={selection.kind === 'admin-agents'} target={{ kind: 'admin-agents' }} onSelect={onSelect} />
      </Col>
    </Col>
  );
}

function AdminPage({ selection }: { selection: AdminSelection }): ReactNode {
  if (selection.kind === 'admin-organizations') return <AdminOrganizations />;
  if (selection.kind === 'admin-agents') return <AdminAgents />;
  return <AdminUsers />;
}

export function AdminArea({ selection, onLock }: { selection: AdminSelection; onLock: () => void }): ReactNode {
  return (
    <Frame
      selection={selection}
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
