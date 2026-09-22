import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui.js';
import { LIST_ICON_SIZE, ListRow } from './ListRow.js';
import { Pill } from './Pill.js';
import { AgentAvatar } from './AgentAvatar.js';
import { StationIcon } from './StationIcon.js';
import { ChatIcon } from './ChatIcon.js';
import { ConnectorFavicon } from './ConnectorFavicon.js';
import { stationLabel } from '../api/attach.js';
import { flattenAccounts, stationFields, type AccountGroup } from '../api/accounts.js';
import { type Connector } from '../api/connectors.js';
import { type Server } from '../api/servers.js';
import { useClaudeSessionQuery, useServerStatus } from '../api/queries.js';
import { type ClaudeSessionStatus } from '../api/claude-box.js';
import { routeHash } from '../route.js';
import { opensElsewhere } from './link.js';
import { type Selection } from './selection.js';

const PAGE_AVATAR = 56;
const CONNECTOR_ICON = 18;
const CHAT_ICON = 18;

export function AgentPicture({ server, seed }: { server: Server | undefined; seed: string }): ReactNode {
  if (server === undefined) return <AgentAvatar seed={seed} size={PAGE_AVATAR} />;
  return <AgentAvatar seed={server.host} src={server.avatar} size={PAGE_AVATAR} />;
}

function harnessLabel(status: ClaudeSessionStatus | undefined): string {
  if (status === undefined) return 'Harness · checking';
  if (status.running) return 'Harness · running';
  if (status.blocked !== null) return 'Harness · waiting';
  return 'Harness · not running';
}

export function StatusPills({ host, project, onSelect }: { host: string | null; project: string; onSelect: (s: Selection) => void }): ReactNode {
  const status = useServerStatus(host ?? '');
  const session = useClaudeSessionQuery();
  const target: Selection = { kind: 'claude', project };
  const live = status.data?.state === 'live';
  return (
    <Row gap={8} align="center" wrap>
      {host === null || status.data === undefined ? (
        <Pill label="Checking" />
      ) : (
        <Pill label={live ? 'Live' : status.data.state === 'stopped' ? 'Stopped' : 'Offline'} variant={live ? 'primary' : 'default'} />
      )}
      <a
        className="pill-link"
        href={routeHash(target)}
        onClick={(e) => {
          if (opensElsewhere(e)) return;
          e.preventDefault();
          onSelect(target);
        }}
      >
        <Pill label={harnessLabel(session.data)} variant={session.data?.running === true ? 'primary' : 'default'} />
      </a>
    </Row>
  );
}

export function ChannelCards({ groups, project, onSelect }: { groups: AccountGroup[]; project: string; onSelect: (s: Selection) => void }): ReactNode {
  const palette = useKitPalette();
  const accounts = flattenAccounts(groups).filter((a) => a.row.id !== null);
  if (accounts.length === 0)
    return (
      <Text size="sm" role="secondary">
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
            onOpen={() => {
              onSelect(target);
            }}
            trailing={
              url === undefined ? undefined : (
                <a className="kebab kebab-lg" href={url} target="_blank" rel="noreferrer" aria-label={`Message on ${stationLabel(a.station)}`}>
                  <ChatIcon size={CHAT_ICON} color={palette.link} />
                </a>
              )
            }
          />
        );
      })}
    </Col>
  );
}

export function ConnectorIcons({ connectors, project, onSelect }: { connectors: Connector[]; project: string; onSelect: (s: Selection) => void }): ReactNode {
  if (connectors.length === 0)
    return (
      <Text size="sm" role="secondary">
        No connector yet.
      </Text>
    );
  return (
    <Row gap={8} wrap>
      {connectors.map((c) => {
        const target: Selection = { kind: 'connector', project, id: c.id };
        return (
          <a
            key={c.id}
            className="connector-chip"
            href={routeHash(target)}
            onClick={(e) => {
              if (opensElsewhere(e)) return;
              e.preventDefault();
              onSelect(target);
            }}
          >
            <ConnectorFavicon name={c.name} url={c.url} size={CONNECTOR_ICON} />
            <Text size="sm" numberOfLines={1}>
              {c.name}
            </Text>
          </a>
        );
      })}
    </Row>
  );
}
