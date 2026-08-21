import { type ReactNode } from 'react';
import { Pressable as RNPressable, ScrollView } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Icon, type HeroIconName } from '@stage-labs/kit/react-native/icon';
import { Pressable } from '@stage-labs/kit/react-native/pressable';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui';
import { MetroLogo } from './MetroLogo';
import { SidebarFooter } from './SidebarFooter';
import { type Selection } from './selection';

const ROW_PAD = { x: 12, y: 8 } as const;
const ICON_SIZE = 18;
const AGENT_PAGES: Selection['kind'][] = ['none', 'agent', 'station'];

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
        style={{
          marginHorizontal: -12,
          borderRadius: 8,
          backgroundColor: selected ? palette.inputBg : 'transparent',
        }}
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
  const dark = useKitScheme() === 'dark';
  return (
    <Col style={{ flex: 1, minHeight: 0 }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 24 }}>
        <Col gap={10}>
          <Row style={{ paddingBottom: 6 }}>
            <RNPressable
              accessibilityRole="link"
              aria-label="Metro dashboard"
              onPress={() => {
                onSelect({ kind: 'none' });
              }}
            >
              <MetroLogo size={32} color={dark ? '#ffffff' : '#000000'} />
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
              selected={selection.kind === 'connectors'}
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
