import { type ReactNode } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { serverLabel, type Server } from '@metro-labs/client/api/servers';
import type { StatsConnector } from '@metro-labs/client/api/connector-stats';
import { ConnectorFavicon } from '../ConnectorFavicon.js';
import { Icon } from '../Icon.js';
import { ICON_SIZE } from '../ui/sizes.js';
import { connectorName } from '../../lib/call-stats.js';
import { selectedColor } from '../../lib/theme.js';

const styles = StyleSheet.create({
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999 },
});

interface ActivityFiltersProps {
  servers: Server[];
  agent: string | null;
  onAgent: (agent: string | null) => void;
  connector: StatsConnector | null;
  onConnector: (connector: StatsConnector | null) => void;
}

function Chip({ on, label, onPress, leading, trailing, role = 'tab' }: { on: boolean; label: string; onPress: () => void; leading?: ReactNode; trailing?: ReactNode; role?: 'tab' | 'button' }): ReactNode {
  const palette = useKitPalette();
  const frame = StyleSheet.flatten([styles.chip, on ? { backgroundColor: selectedColor(palette) } : null]);
  return (
    <Pressable accessibilityRole={role} accessibilityLabel={role === 'button' ? `${label}: show every connector` : label} accessibilityState={role === 'tab' ? { selected: on } : undefined} onPress={onPress} style={frame}>
      {leading}
      <Text size="md" role={on ? 'default' : 'secondary'} numberOfLines={1}>
        {label}
      </Text>
      {trailing}
    </Pressable>
  );
}

function ConnectorChip({ connector, onClear }: { connector: StatsConnector; onClear: () => void }): ReactNode {
  const palette = useKitPalette();
  const name = connectorName(connector);
  return (
    <Chip
      on
      role="button"
      label={name}
      onPress={onClear}
      leading={<ConnectorFavicon name={name} url={connector.url ?? ''} size={ICON_SIZE.sm} />}
      trailing={<Icon name="close" size={ICON_SIZE.sm} color={palette.sub} />}
    />
  );
}

export function ActivityFilters({ servers, agent, onAgent, connector, onConnector }: ActivityFiltersProps): ReactNode {
  const agents = servers.length < 2 ? [] : [{ id: null, label: 'All agents' }, ...servers.map((server) => ({ id: server.id, label: serverLabel(server) }))];
  if (agents.length === 0 && connector === null) return null;
  return (
    <Row gap={4} wrap align="center">
      {agents.map((choice) => (
        <Chip key={choice.id ?? 'all'} on={choice.id === agent} label={choice.label} onPress={() => { onAgent(choice.id); }} />
      ))}
      {connector === null ? null : <ConnectorChip connector={connector} onClear={() => { onConnector(null); }} />}
    </Row>
  );
}
