import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { type Selection } from '@metro-labs/client/selection';
import { NAV_GAP, NavRow } from './NavRow.js';

export function PlainSidebar({ selection, onSelect }: { selection: Selection; onSelect: () => void }): ReactNode {
  return (
    <Col flex={1} minHeight={0}>
      <Col gap={NAV_GAP} padding={{ top: 12 }}>
        <NavRow label="Agents" icon="server" selected={selection.kind === 'servers'} target={{ kind: 'servers' }} onSelect={onSelect} />
        <NavRow label="Members" icon="users" selected={selection.kind === 'members'} target={{ kind: 'members' }} onSelect={onSelect} />
        <NavRow label="Organization" icon="officeBuilding" selected={selection.kind === 'organization'} target={{ kind: 'organization' }} onSelect={onSelect} />
      </Col>
    </Col>
  );
}
