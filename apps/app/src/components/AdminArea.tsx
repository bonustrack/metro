import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { type Selection } from '@metro-labs/client/selection';
import { Frame } from './Shell.js';
import { FieldLabel } from './FieldLabel.js';
import { NAV_GAP, NavRow } from './NavRow.js';
import { Pending } from './Pending.js';

export type AdminSelection = { kind: 'admin' } | { kind: 'admin-users' } | { kind: 'admin-organizations' } | { kind: 'admin-agents' };

const ADMIN_KINDS = new Set<Selection['kind']>(['admin', 'admin-users', 'admin-organizations', 'admin-agents']);

export const isAdminSelection = (s: Selection): s is AdminSelection => ADMIN_KINDS.has(s.kind);

function AdminSidebar({ selection, onSelect }: { selection: AdminSelection; onSelect: () => void }): ReactNode {
  return (
    <Col flex={1} minHeight={0}>
      <Col gap={NAV_GAP} padding={{ top: 12 }}>
        <Row padding={{ x: 18, bottom: 6 }}>
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

export function AdminArea({ selection, onLock }: { selection: AdminSelection; onLock: () => void }): ReactNode {
  return (
    <Frame sidebar={(closeMenu) => <AdminSidebar selection={selection} onSelect={closeMenu} />} onLock={onLock}>
      <Pending title="Admin" />
    </Frame>
  );
}
