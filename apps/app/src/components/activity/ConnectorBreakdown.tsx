import { type ReactNode } from 'react';
import { Row } from '@stage-labs/kit/react-native/row';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { isFilterable, type StatsConnector } from '@metro-labs/client/api/connector-stats';
import { ConnectorFavicon } from '../ConnectorFavicon.js';
import { Icon } from '../Icon.js';
import { Group } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { ICON_SIZE } from '../ui/sizes.js';
import { Swatch } from './CallLegend.js';
import { callsWords, connectorName, failedAlarm, percentWords } from '../../lib/call-stats.js';

interface BreakdownProps {
  connectors: StatsConnector[];
  colors: Map<string, string> | null;
  picked: StatsConnector | null;
  onPick: (connector: StatsConnector | null) => void;
}

function Leading({ connector, color }: { connector: StatsConnector; color: string | undefined }): ReactNode {
  const name = connectorName(connector);
  return (
    <Row gap={10} align="center">
      {color === undefined ? null : <Swatch color={color} />}
      <ConnectorFavicon name={name} url={connector.url ?? ''} size={ICON_SIZE.lg} />
    </Row>
  );
}

function ConnectorRow({ connector, color, picked, onPick }: { connector: StatsConnector; color: string | undefined; picked: boolean; onPick: BreakdownProps['onPick'] }): ReactNode {
  const palette = useKitPalette();
  const name = connectorName(connector);
  const failed = `${percentWords(connector.failed, connector.total)} failed`;
  const press = isFilterable(connector) ? () => { onPick(picked ? null : connector); } : undefined;
  return (
    <Item
      title={name}
      subtitle={picked ? `${failed}. Showing only this connector.` : failed}
      subtitleTone={failedAlarm(connector.failed, connector.total) ? 'danger' : 'secondary'}
      leading={<Leading connector={connector} color={color} />}
      value={callsWords(connector.total)}
      trailing={picked ? <Icon name="close" size={ICON_SIZE.md} color={palette.sub} /> : undefined}
      chevron={false}
      onPress={press}
      label={picked ? `${name}: show every connector` : `${name}: show only this connector`}
    />
  );
}

export function ConnectorBreakdown({ connectors, colors, picked, onPick }: BreakdownProps): ReactNode {
  if (connectors.length === 0) return null;
  return (
    <Group label="By connector" wide>
      {connectors.map((connector) => (
        <ConnectorRow key={connector.key} connector={connector} color={colors?.get(connector.key)} picked={picked?.key === connector.key} onPick={onPick} />
      ))}
    </Group>
  );
}
