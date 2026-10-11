import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { type Selection } from '@metro-labs/client/selection';
import { NAV_GAP, NavRow } from './NavRow.js';
import { useOrgConnectorsQuery } from '../lib/org-connector-queries.js';

const ORG_CONNECTOR_PAGES = new Set<Selection['kind']>(['org-connectors', 'org-connector']);

export function PlainSidebar({ selection, onSelect }: { selection: Selection; onSelect: () => void }): ReactNode {
  const connectors = useOrgConnectorsQuery().data !== undefined || ORG_CONNECTOR_PAGES.has(selection.kind);
  return (
    <Col flex={1} minHeight={0}>
      <Col gap={NAV_GAP} padding={{ top: 12 }}>
        <NavRow label="Agents" icon="server" selected={selection.kind === 'servers'} target={{ kind: 'servers' }} onSelect={onSelect} />
        <NavRow label="Members" icon="users" selected={selection.kind === 'members'} target={{ kind: 'members' }} onSelect={onSelect} />
        {connectors ? <NavRow label="Connectors" icon="viewGridAdd" selected={ORG_CONNECTOR_PAGES.has(selection.kind)} target={{ kind: 'org-connectors' }} onSelect={onSelect} /> : null}
        <NavRow label="Organization" icon="officeBuilding" selected={selection.kind === 'organization'} target={{ kind: 'organization' }} onSelect={onSelect} />
      </Col>
    </Col>
  );
}
