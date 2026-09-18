import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { SidebarFooter } from './SidebarFooter.js';
import { NAV_GAP, NavRow } from './NavRow.js';
import { type Selection } from './selection.js';

interface PlainSidebarProps {
  selection: Selection;
  subject: string;
  onSelect: (selection: Selection) => void;
  onLock: () => void;
}

export function PlainSidebar({ selection, subject, onSelect, onLock }: PlainSidebarProps): ReactNode {
  return (
    <Col flex={1} minHeight={0}>
      <Col gap={NAV_GAP} padding={{ x: 24, top: 24 }}>
        <NavRow label="Agents" icon="server" selected={selection.kind === 'servers'} target={{ kind: 'servers' }} onSelect={onSelect} />
        <NavRow label="Members" icon="users" selected={selection.kind === 'members'} target={{ kind: 'members' }} onSelect={onSelect} />
        <NavRow label="Organization" icon="officeBuilding" selected={selection.kind === 'organization'} target={{ kind: 'organization' }} onSelect={onSelect} />
      </Col>
      <Col flex={1} />
      <SidebarFooter subject={subject} selection={selection} onSelect={onSelect} onLock={onLock} />
    </Col>
  );
}
