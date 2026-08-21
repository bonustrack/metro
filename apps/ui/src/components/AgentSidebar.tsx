import { type ReactNode } from 'react';
import { ScrollView } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Icon, type HeroIconName } from '@stage-labs/kit/react-native/icon';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui';
import { MetroLogo } from './MetroLogo';
import { SidebarFooter } from './SidebarFooter';
import { opensElsewhere } from './link';
import { routeHash } from '../route';
import { type Selection } from './selection';

const ROW_PAD = { x: 12, y: 8 } as const;
const ICON_SIZE = 18;
const SCROLL = { flex: 1 } as const;
const SCROLL_CONTENT = { padding: 24 } as const;
const AGENT_PAGES: Selection['kind'][] = ['none', 'agent', 'station'];
const CONNECTOR_PAGES: Selection['kind'][] = ['connectors', 'connector'];

interface NavRowProps {
  label: string;
  icon?: HeroIconName;
  selected: boolean;
  target: Selection;
  onSelect: (selection: Selection) => void;
}

function NavRow({
  label,
  icon,
  selected,
  target,
  onSelect,
}: NavRowProps): ReactNode {
  const palette = useKitPalette();
  return (
    <a
      className="nav-link"
      href={routeHash(target)}
      onClick={(e) => {
        if (opensElsewhere(e)) return;
        e.preventDefault();
        onSelect(target);
      }}
    >
      <Row
        align="center"
        gap={10}
        padding={ROW_PAD}
        margin={{ x: -12 }}
      >
        {icon === undefined ? null : (
          <Icon
            name={icon}
            size={ICON_SIZE}
            color={selected ? palette.link : palette.sub}
          />
        )}
        <Text size="xl" role={selected ? 'link' : 'secondary'} numberOfLines={1}>
          {label}
        </Text>
      </Row>
    </a>
  );
}

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
          <Col>
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
