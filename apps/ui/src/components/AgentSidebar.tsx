import { type ReactNode } from 'react';
import { Pressable as RNPressable, ScrollView } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Icon, type HeroIconName } from '@stage-labs/kit/react-native/icon';
import { BUTTON_RADIUS_DEFAULT } from '@stage-labs/kit/tokens';
import { Pressable } from '@stage-labs/kit/react-native/pressable';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui';
import { MetroLogo } from './MetroLogo';
import { SidebarFooter } from './SidebarFooter';
import { type Selection } from './selection';

const ROW_PAD = { x: 12, y: 11 } as const;
const ICON_SIZE = 18;
const SCROLL = { flex: 1 } as const;
const SCROLL_CONTENT = { padding: 24 } as const;
const AGENT_PAGES: Selection['kind'][] = ['none', 'agent', 'station'];
const CONNECTOR_PAGES: Selection['kind'][] = ['connectors', 'connector'];

interface NavRowProps {
  label: string;
  icon?: HeroIconName;
  selected: boolean;
  onPress: () => void;
}

function NavRow({
  label,
  icon,
  selected,
  onPress,
}: NavRowProps): ReactNode {
  const palette = useKitPalette();
  return (
    <Pressable pressedOpacity={0.6} onPress={onPress}>
      <Row
        align="center"
        gap={10}
        padding={ROW_PAD}
        margin={{ x: -12 }}
        radius={BUTTON_RADIUS_DEFAULT}
        background={selected ? palette.border : undefined}
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
    </Pressable>
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
          <Row padding={{ bottom: 6 }}>
            <RNPressable
              accessibilityRole="link"
              aria-label="Metro dashboard"
              onPress={() => {
                onSelect({ kind: 'none' });
              }}
            >
              <MetroLogo size={32} color={palette.link} />
            </RNPressable>
          </Row>
          <Col>
            <NavRow
              label="Agents"
              icon="users"
              selected={AGENT_PAGES.includes(selection.kind)}
              onPress={() => {
                onSelect({ kind: 'none' });
              }}
            />
            <NavRow
              label="Connectors"
              icon="lightningBolt"
              selected={CONNECTOR_PAGES.includes(selection.kind)}
              onPress={() => {
                onSelect({ kind: 'connectors' });
              }}
            />
            <NavRow
              label="Settings"
              icon="cog"
              selected={selection.kind === 'settings'}
              onPress={() => {
                onSelect({ kind: 'settings' });
              }}
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
