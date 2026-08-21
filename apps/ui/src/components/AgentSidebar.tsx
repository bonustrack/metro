import { type ReactNode } from 'react';
import { Pressable as RNPressable, ScrollView } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Icon, type HeroIconName } from '@stage-labs/kit/react-native/icon';
import { Pressable } from '@stage-labs/kit/react-native/pressable';
import { Spacer } from '@stage-labs/kit/react-native/spacer';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui';
import { Blockies } from './Blockies';
import { MetroLogo } from './MetroLogo';
import { countAccounts, type AccountGroup } from '../api/accounts';
import { type AgentSummary } from '../api/client';
import { SidebarFooter } from './SidebarFooter';
import { type Selection } from './selection';

const ROW_PAD = { x: 12, y: 8 } as const;
const ICON_SIZE = 18;

interface NavRowProps {
  label: string;
  icon?: HeroIconName;
  avatar?: string;
  trailing?: string;
  selected: boolean;
  onPress: () => void;
}

function NavRow({
  label,
  icon,
  avatar,
  trailing,
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
        {avatar === undefined ? null : <Blockies seed={avatar} size={ICON_SIZE} />}
        <Text size="xl" role={selected ? 'link' : 'secondary'} numberOfLines={1}>
          {label}
        </Text>
        <Spacer />
        {trailing === undefined ? null : (
          <Text size="lg" role="secondary">{trailing}</Text>
        )}
      </Row>
    </Pressable>
  );
}

interface AgentSidebarProps {
  agents: AgentSummary[];
  groups: AccountGroup[];
  selection: Selection;
  email: string;
  onSelect: (selection: Selection) => void;
  onLock: () => void;
}

export function AgentSidebar({
  agents,
  groups,
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
              selected={selection.kind === 'none'}
              onPress={() => {
                onSelect({ kind: 'none' });
              }}
            />
            {agents.map((a) => (
              <NavRow
                key={a.id}
                avatar={a.name}
                label={a.owned ? a.name : `${a.name} · not owned`}
                trailing={String(countAccounts(groups, a.id))}
                selected={selection.kind === 'agent' && selection.id === a.id}
                onPress={() => {
                  onSelect({ kind: 'agent', id: a.id });
                }}
              />
            ))}
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
