import { type ReactNode } from 'react';
import { ScrollView } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { MetroLogo } from './MetroLogo';
import { NAV_GAP, NavRow } from './NavRow';
import { SidebarFooter } from './SidebarFooter';
import { opensElsewhere } from './link';
import { routeHash } from '../route';
import { type Selection } from './selection';

const SCROLL = { flex: 1 } as const;
const SCROLL_CONTENT = { padding: 24 } as const;
const HOME_PAGES: Selection['kind'][] = ['home', 'none'];
const STATION_PAGES: Selection['kind'][] = ['stations', 'station'];
const CONNECTOR_PAGES: Selection['kind'][] = ['connectors', 'connector'];

interface AgentSidebarProps {
  project: string;
  selection: Selection;
  subject: string;
  onSelect: (selection: Selection) => void;
  onLock: () => void;
}

export function AgentSidebar({ project, selection, subject, onSelect, onLock }: AgentSidebarProps): ReactNode {
  const palette = useKitPalette();
  const home: Selection = { kind: 'home', project };
  return (
    <Col flex={1} minHeight={0}>
      <ScrollView style={SCROLL} contentContainerStyle={SCROLL_CONTENT}>
        <Col gap={10}>
          <Row padding={{ bottom: 22 }}>
            <a
              className="nav-link"
              href={routeHash(home)}
              aria-label="This machine"
              onClick={(e) => {
                if (opensElsewhere(e)) return;
                e.preventDefault();
                onSelect(home);
              }}
            >
              <MetroLogo size={32} color={palette.link} />
            </a>
          </Row>
          <Col gap={NAV_GAP}>
            <NavRow label="Agent" icon="lightningBolt" selected={HOME_PAGES.includes(selection.kind)} target={home} onSelect={onSelect} />
            <NavRow label="Stations" icon="users" selected={STATION_PAGES.includes(selection.kind)} target={{ kind: 'stations', project }} onSelect={onSelect} />
            <NavRow label="Connectors" icon="viewGridAdd" selected={CONNECTOR_PAGES.includes(selection.kind)} target={{ kind: 'connectors', project }} onSelect={onSelect} />
            <NavRow label="Sessions" icon="folder" selected={selection.kind === 'sessions'} target={{ kind: 'sessions', project, claudeProject: null, id: null }} onSelect={onSelect} />
            <NavRow label="Memory" icon="bookOpen" selected={selection.kind === 'memory'} target={{ kind: 'memory', project, claudeProject: null, file: null }} onSelect={onSelect} />
          </Col>
        </Col>
      </ScrollView>
      <SidebarFooter project={project} subject={subject} selection={selection} onSelect={onSelect} onLock={onLock} />
    </Col>
  );
}
