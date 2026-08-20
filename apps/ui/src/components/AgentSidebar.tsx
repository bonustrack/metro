import { type ReactNode } from 'react';
import { Pressable } from 'react-native';
import { ScrollView } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Card } from '@stage-labs/kit/react-native/card';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';
import { MetroLogo } from './MetroLogo';
import { CARD_PADDING_ROW } from '../theme';
import { countAccounts, type AccountGroup } from '../api/accounts';
import { type AgentSummary } from '../api/client';
import { SidebarFooter } from './SidebarFooter';
import { type Selection } from './selection';

interface AgentItemProps {
  agent: AgentSummary;
  accounts: number;
  selected: boolean;
  onPress: () => void;
}

function AgentItem({ agent, accounts, selected, onPress }: AgentItemProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const palette = useKitPalette();
  return (
    <Card
      dark={dark}
      padding={CARD_PADDING_ROW}
      background={selected ? undefined : palette.bg}
      onPress={onPress}
    >
      <Col gap={2}>
        <Text size="lg" weight="semibold">{agent.name}</Text>
        <Text size="sm" role="secondary">
          {accounts} station{accounts === 1 ? '' : 's'}
          {agent.owned ? '' : ' · granted'}
        </Text>
      </Col>
    </Card>
  );
}

interface AgentSidebarProps {
  agents: AgentSummary[];
  groups: AccountGroup[];
  selection: Selection;
  email: string;
  onSelect: (selection: Selection) => void;
  onNew: () => void;
  onLock: () => void;
}

export function AgentSidebar({
  agents,
  groups,
  selection,
  email,
  onSelect,
  onNew,
  onLock,
}: AgentSidebarProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Col style={{ flex: 1, minHeight: 0 }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 24 }}>
        <Col gap={10}>
      <Row style={{ paddingBottom: 6 }}>
        <Pressable
          accessibilityRole="link"
          aria-label="Metro dashboard"
          onPress={() => {
            onSelect({ kind: 'none' });
          }}
        >
          <MetroLogo size={32} color={dark ? '#ffffff' : '#000000'} />
        </Pressable>
      </Row>
      <Row justify="between" align="center" gap={10} wrap>
        <Text size="2xl" weight="semibold">Agents</Text>
        <Button
          size="md"
          color="primary"
          dark={dark}
          label="New agent"
          onPress={onNew}
        />
      </Row>
      {agents.length === 0 ? (
        <Text size="lg" role="secondary">No agents yet.</Text>
      ) : (
        <Col gap={8}>
          {agents.map((a) => (
            <AgentItem
              key={a.id}
              agent={a}
              accounts={countAccounts(groups, a.id)}
              selected={selection.kind === 'agent' && selection.id === a.id}
              onPress={() => {
                onSelect({ kind: 'agent', id: a.id });
              }}
            />
          ))}
        </Col>
      )}
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
