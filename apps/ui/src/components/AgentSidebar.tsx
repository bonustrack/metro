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
const AGENT_PAGES: Selection['kind'][] = ['none', 'agent', 'station'];
const CONNECTOR_PAGES: Selection['kind'][] = ['connectors', 'connector'];

interface AgentSidebarProps {
  selection: Selection;
  email: string;
  onSelect: (selection: Selection) => void;
  onLock: () => void;
}

export function AgentSidebar({
  selection,
  email,
  onSelect,
  onLock,
}: AgentSidebarProps): ReactNode {
  const palette = useKitPalette();
  return (
    <Col flex={1} minHeight={0}>
      <ScrollView style={SCROLL} contentContainerStyle={SCROLL_CONTENT}>
        <Col gap={10}>
          <Row padding={{ bottom: 22 }}>
            <a
              className="nav-link"
              href={routeHash({ kind: 'none' })}
              aria-label="Metro dashboard"
              onClick={(e) => {
                if (opensElsewhere(e)) return;
                e.preventDefault();
                onSelect({ kind: 'none' });
              }}
            >
              <MetroLogo size={32} color={palette.link} />
            </a>
          </Row>
          <Col gap={NAV_GAP}>
            <NavRow
              label="Agents"
              icon="users"
              selected={AGENT_PAGES.includes(selection.kind)}
              target={{ kind: 'none' }}
              onSelect={onSelect}
            />
            <NavRow
              label="Connectors"
              icon="lightningBolt"
              selected={CONNECTOR_PAGES.includes(selection.kind)}
              target={{ kind: 'connectors' }}
              onSelect={onSelect}
            />
            <NavRow
              label="Settings"
              icon="cog"
              selected={selection.kind === 'settings'}
              target={{ kind: 'settings' }}
              onSelect={onSelect}
            />
          </Col>
        </Col>
      </ScrollView>
      <SidebarFooter
        email={email}
        selection={selection}
        onSelect={onSelect}
        onLock={onLock}
      />
    </Col>
  );
}
