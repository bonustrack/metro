import { type ReactNode } from 'react';
import { ScrollView } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { NAV_GAP, NavRow } from './NavRow.js';
import { OrganizationSwitcher } from './OrganizationSwitcher.js';
import { FieldLabel } from './FieldLabel.js';
import { type Selection } from './selection.js';

const SCROLL = { flex: 1 } as const;
const SCROLL_CONTENT = { padding: 24 } as const;
const HOME_PAGES: Selection['kind'][] = ['home', 'none'];
const STATION_PAGES: Selection['kind'][] = ['stations', 'station'];
const CONNECTOR_PAGES: Selection['kind'][] = ['connectors', 'connector'];
const SKILL_PAGES: Selection['kind'][] = ['skills', 'skill'];

interface AgentSidebarProps {
  project: string;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  offline?: boolean;
}

export function AgentSidebar({ project, selection, onSelect, offline = false }: AgentSidebarProps): ReactNode {
  const home: Selection = { kind: 'home', project };
  return (
    <Col flex={1} minHeight={0}>
      <ScrollView style={SCROLL} contentContainerStyle={SCROLL_CONTENT}>
        <Col gap={10}>
          <Col padding={{ bottom: 4 }}>
            <OrganizationSwitcher />
          </Col>
          <Col gap={NAV_GAP}>
            <NavRow label="Agent" icon="user" selected={HOME_PAGES.includes(selection.kind)} target={home} onSelect={onSelect} />
            <NavRow label="Settings" icon="cog" selected={selection.kind === 'agent-settings'} target={{ kind: 'agent-settings', project }} onSelect={onSelect} />
          </Col>
          <Col gap={NAV_GAP} padding={{ top: 14 }}>
            <Row padding={{ bottom: 2 }}>
              <FieldLabel>Runtime</FieldLabel>
            </Row>
            <NavRow label="Server" icon="server" selected={selection.kind === 'server'} target={{ kind: 'server', project }} onSelect={onSelect} disabled={offline} />
            <NavRow label="Model" icon="chip" selected={selection.kind === 'model'} target={{ kind: 'model', project }} onSelect={onSelect} disabled={offline} />
            <NavRow label="Harness" icon="cube" selected={selection.kind === 'claude'} target={{ kind: 'claude', project }} onSelect={onSelect} disabled={offline} />
            <NavRow label="Scheduled" icon="calendar" selected={selection.kind === 'scheduled'} target={{ kind: 'scheduled', project }} onSelect={onSelect} disabled={offline} />
            <NavRow label="Terminal" icon="terminal" selected={selection.kind === 'terminal'} target={{ kind: 'terminal', project }} onSelect={onSelect} disabled={offline} />
          </Col>
          <Col gap={NAV_GAP} padding={{ top: 14 }}>
            <Row padding={{ bottom: 2 }}>
              <FieldLabel>Customize</FieldLabel>
            </Row>
            <NavRow label="Skills" icon="sparkles" selected={SKILL_PAGES.includes(selection.kind)} target={{ kind: 'skills', project }} onSelect={onSelect} disabled={offline} />
            <NavRow label="Channels" icon="chat" selected={STATION_PAGES.includes(selection.kind)} target={{ kind: 'stations', project }} onSelect={onSelect} disabled={offline} />
            <NavRow label="Connectors" icon="viewGridAdd" selected={CONNECTOR_PAGES.includes(selection.kind)} target={{ kind: 'connectors', project }} onSelect={onSelect} disabled={offline} />
            <NavRow label="Memory" icon="bookmark" selected={selection.kind === 'memory'} target={{ kind: 'memory', project, claudeProject: null, file: null }} onSelect={onSelect} disabled={offline} />
            <NavRow label="Sessions" icon="clock" selected={selection.kind === 'sessions'} target={{ kind: 'sessions', project, claudeProject: null, id: null }} onSelect={onSelect} disabled={offline} />
          </Col>
        </Col>
      </ScrollView>
    </Col>
  );
}
