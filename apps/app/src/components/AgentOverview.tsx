import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from '@stage-labs/kit/react-native/text';
import { LIST_ICON_SIZE, ListRow } from './ListRow.js';
import { StationIcon } from './StationIcon.js';
import { ChatIcon } from './ChatIcon.js';
import { ConnectorFavicon } from './ConnectorFavicon.js';
import { stationLabel } from '@metro-labs/client/api/attach';
import { flattenAccounts, stationFields, type AccountGroup } from '@metro-labs/client/api/accounts';
import type { OrgConnector } from '@metro-labs/client/api/org-connectors';
import { routeHash } from '@metro-labs/client/route';
import { RouteLink } from './RouteLink.js';
import { RoundButton } from './RoundButton.js';
import { openExternal } from '../lib/open.js';
import { type Selection } from '@metro-labs/client/selection';

const CONNECTOR_ICON = 18;
const CHAT_ICON = 18;
const CHIP = { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5, paddingLeft: 8, paddingRight: 12, borderWidth: 1, borderRadius: 999 } as const;

export function ChannelCards({ groups, project }: { groups: AccountGroup[]; project: string }): ReactNode {
  const palette = useKitPalette();
  const accounts = flattenAccounts(groups).filter((a) => a.row.id !== null);
  if (accounts.length === 0)
    return (
      <Text size="md" role="secondary">
        No channel yet.
      </Text>
    );
  return (
    <Col>
      {accounts.map((a) => {
        const id = a.row.id ?? '';
        const { handle, url } = stationFields(a.row);
        const target: Selection = { kind: 'station', project, accountId: id };
        return (
          <ListRow
            key={`${a.station}/${id}`}
            title={stationLabel(a.station)}
            detail={handle ?? id}
            href={routeHash(target)}
            icon={<StationIcon station={a.station} size={LIST_ICON_SIZE} />}
            trailing={
              url === undefined ? undefined : (
                <RoundButton label={`Message on ${stationLabel(a.station)}`} size={40} onPress={() => openExternal(url)}>
                  <ChatIcon size={CHAT_ICON} color={palette.link} />
                </RoundButton>
              )
            }
          />
        );
      })}
    </Col>
  );
}

export function ConnectorIcons({ connectors }: { connectors: OrgConnector[] }): ReactNode {
  const palette = useKitPalette();
  const chip = [CHIP, { borderColor: palette.border }];
  const hover = { backgroundColor: palette.inputBg };
  if (connectors.length === 0)
    return (
      <Text size="md" role="secondary">
        No connector yet.
      </Text>
    );
  return (
    <Row gap={8} wrap>
      {connectors.map((c) => {
        const target: Selection = { kind: 'org-connector', id: c.id };
        return (
          <RouteLink key={c.id} to={routeHash(target)} label={c.name} style={chip} hoverStyle={hover}>
            <ConnectorFavicon name={c.name} url={c.url} size={CONNECTOR_ICON} />
            <Text size="md" numberOfLines={1}>
              {c.name}
            </Text>
          </RouteLink>
        );
      })}
    </Row>
  );
}
