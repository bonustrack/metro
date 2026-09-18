import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui.js';
import { SHRINK } from '../theme.js';
import { Pill } from './Pill.js';
import { AgentAvatar } from './AgentAvatar.js';
import { useAvatarPicker } from './AvatarPicker.js';
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
const CARD_RADIUS = 8;
const CARD_MIN = 200;
const CARD_MAX = 320;
const STATION_ICON = 24;
const CONNECTOR_ICON = 28;

export function AvatarButton({ server, seed }: { server: Server | undefined; seed: string }): ReactNode {
  if (server === undefined) return <AgentAvatar seed={seed} size={PAGE_AVATAR} />;
  return <PickableAvatar server={server} />;
}

function PickableAvatar({ server }: { server: Server }): ReactNode {
  const avatar = useAvatarPicker(server);
  return (
    <>
      <button type="button" className="avatar-button" title="Change the avatar" disabled={avatar.busy} onClick={avatar.pick}>
        <AgentAvatar seed={server.host} src={server.avatar} size={PAGE_AVATAR} />
      </button>
      {avatar.input}
      {avatar.error === null ? null : (
        <Text size="sm" role="danger">
          {avatar.error}
        </Text>
      )}
    </>
  );
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

function ChannelCard({ station, handle, url, href, onOpen }: { station: string; handle: string; url: string | undefined; href: string; onOpen: () => void }): ReactNode {
  const palette = useKitPalette();
  const side = { width: 1, color: palette.border };
  return (
    <Row
      align="center"
      gap={8}
      flex={1}
      minWidth={CARD_MIN}
      maxWidth={CARD_MAX}
      padding={{ x: 12 }}
      radius={CARD_RADIUS}
      border={{ top: side, right: side, bottom: side, left: side }}
    >
      <a
        className="row-link"
        href={href}
        onClick={(e) => {
          if (opensElsewhere(e)) return;
          e.preventDefault();
          onOpen();
        }}
      >
        <StationIcon station={station} size={STATION_ICON} />
        <Col gap={2} flex={1} minWidth={0}>
          <Text size="md" weight="semibold" numberOfLines={1}>
            {stationLabel(station)}
          </Text>
          <Text size="xs" role="secondary" numberOfLines={1} style={SHRINK}>
            {handle}
          </Text>
        </Col>
      </a>
      {url === undefined ? null : (
        <a className="kebab" href={url} target="_blank" rel="noreferrer" aria-label={`Message on ${stationLabel(station)}`} title={`Message on ${stationLabel(station)}`}>
          <ChatIcon size={18} color={palette.link} />
        </a>
      )}
    </Row>
  );
}

export function ChannelCards({ groups, project, onSelect }: { groups: AccountGroup[]; project: string; onSelect: (s: Selection) => void }): ReactNode {
  const accounts = flattenAccounts(groups).filter((a) => a.row.id !== null);
  if (accounts.length === 0)
    return (
      <Text size="sm" role="secondary">
        No channel yet.
      </Text>
    );
  return (
    <Row gap={12} wrap>
      {accounts.map((a) => {
        const id = a.row.id ?? '';
        const { handle, url } = stationFields(a.row);
        const target: Selection = { kind: 'station', project, accountId: id };
        return (
          <ChannelCard
            key={`${a.station}/${id}`}
            station={a.station}
            handle={handle ?? id}
            url={url}
            href={routeHash(target)}
            onOpen={() => {
              onSelect(target);
            }}
          />
        );
      })}
    </Row>
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
            className="kebab kebab-lg"
            href={routeHash(target)}
            title={c.name}
            aria-label={c.name}
            onClick={(e) => {
              if (opensElsewhere(e)) return;
              e.preventDefault();
              onSelect(target);
            }}
          >
            <ConnectorFavicon name={c.name} url={c.url} size={CONNECTOR_ICON} />
          </a>
        );
      })}
    </Row>
  );
}
