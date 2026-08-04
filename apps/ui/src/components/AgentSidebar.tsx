import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Card } from '@stage-labs/kit/react-native/card';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';
import { CARD_PADDING_ROW } from '../theme';
import { countAccounts, type AccountGroup } from '../api/accounts';
import { type AgentSummary } from '../api/client';
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
        <Text size="sm" weight="semibold">{agent.name}</Text>
        <Text size="2xs" role="secondary">
          {accounts} account{accounts === 1 ? '' : 's'}
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
  onSelect: (selection: Selection) => void;
}

export function AgentSidebar({
  agents,
  groups,
  selection,
  onSelect,
}: AgentSidebarProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Col gap={10}>
      <Row justify="between" align="center" gap={10} wrap>
        <Text size="lg" weight="semibold">Agents</Text>
        <Button
          size="sm"
          color="primary"
          dark={dark}
          label="New agent"
          onPress={() => {
            onSelect({ kind: 'new' });
          }}
        />
      </Row>
      {agents.length === 0 ? (
        <Text size="sm" role="secondary">No agents yet.</Text>
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
  );
}
