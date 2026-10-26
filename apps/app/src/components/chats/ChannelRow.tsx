import { type ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { CheckBox } from '@stage-labs/kit/react-native/check-box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { stationLabel } from '@metro-labs/client/api/attach';
import { stationFields, type FlatAccount } from '@metro-labs/client/api/accounts';
import { routeHash } from '@metro-labs/client/route';
import { Icon } from '../Icon.js';
import { RouteLink } from '../RouteLink.js';
import { StationIcon } from '../StationIcon.js';
import { side } from '../ui/edges.js';
import { writersSummary } from '../../lib/channel-people.js';
import { ICON_SIZE } from '../ui/sizes.js';

const CHEVRON = 20;

const styles = StyleSheet.create({
  link: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14 },
  chevron: { paddingVertical: 14, marginLeft: -6 },
});

export const channelTitle = (item: FlatAccount): string => stationFields(item.row).handle ?? item.row.id ?? stationLabel(item.station);

function subtitleOf(item: FlatAccount): string {
  const label = stationLabel(item.station);
  if (!item.row.enabled) return `${label} · Not receiving`;
  if (item.stale) return `${label} · Not responding`;
  const who = writersSummary(item.row.allowlist);
  return who === null || who === '' ? label : `${label} · ${who}`;
}

interface ChannelRowProps {
  item: FlatAccount;
  project: string;
  receiving: boolean;
  busy: boolean;
  onToggle: (next: boolean) => void;
}

export function ChannelRow({ item, project, receiving, busy, onToggle }: ChannelRowProps): ReactNode {
  const palette = useKitPalette();
  const id = item.row.id;
  const title = channelTitle(item);
  const href = routeHash(id === null ? { kind: 'chats', project } : { kind: 'station', project, accountId: id });
  const stale = item.stale && item.row.enabled;
  return (
    <Row align="center" gap={14} minHeight={60} border={{ bottom: side(palette.border) }}>
      <RouteLink to={href} label={title} style={styles.link}>
        <StationIcon station={item.station} size={ICON_SIZE.lg} />
        <Column weight={1} minWidth={0} gap={2}>
          <Text size="md" numberOfLines={1}>
            {title}
          </Text>
          <Text size="xs" color={stale ? 'danger' : 'secondary'} numberOfLines={1}>
            {subtitleOf(item)}
          </Text>
        </Column>
      </RouteLink>
      {id === null ? null : <CheckBox displayStyle="switch" value={receiving} disabled={busy} name={`Receive messages on ${title}`} onChange={onToggle} />}
      <RouteLink to={href} label={`Open ${title}`} style={styles.chevron}>
        <Icon name="chevronRight" size={CHEVRON} color={palette.sub} />
      </RouteLink>
    </Row>
  );
}
