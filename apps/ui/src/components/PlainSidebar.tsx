import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { NAV_GAP, NavRow } from './NavRow.js';
import { OrganizationSwitcher } from './OrganizationSwitcher.js';
import { type Selection } from './selection.js';
import { isOperator } from '../api/admin.js';
import { activeAccount } from '../auth/account.js';

interface PlainSidebarProps {
  selection: Selection;
  onSelect: (selection: Selection) => void;
}

export function PlainSidebar({ selection, onSelect }: PlainSidebarProps): ReactNode {
  return (
    <Col flex={1} minHeight={0}>
      <Col gap={NAV_GAP} padding={{ x: 24, top: 24 }}>
        <Col padding={{ bottom: 10 }}>
          <OrganizationSwitcher />
        </Col>
        <NavRow label="Agents" icon="server" selected={selection.kind === 'servers'} target={{ kind: 'servers' }} onSelect={onSelect} />
        <NavRow label="Members" icon="users" selected={selection.kind === 'members'} target={{ kind: 'members' }} onSelect={onSelect} />
        <NavRow label="Organization" icon="officeBuilding" selected={selection.kind === 'organization'} target={{ kind: 'organization' }} onSelect={onSelect} />
        {isOperator(activeAccount()) ? <NavRow label="Admin" icon="shieldCheck" selected={false} target={{ kind: 'admin' }} onSelect={onSelect} /> : null}
      </Col>
    </Col>
  );
}
