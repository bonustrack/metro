import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from '@stage-labs/kit/react-native/text';
import { LIST_ICON_SIZE, ListRow } from './ListRow.js';
import { AgentAvatar } from './AgentAvatar.js';
import { StationIcon } from './StationIcon.js';
import { ChatIcon } from './ChatIcon.js';
import { ConnectorFavicon } from './ConnectorFavicon.js';
import { stationLabel } from '@metro-labs/client/api/attach';
import { flattenAccounts, stationFields, type AccountGroup } from '@metro-labs/client/api/accounts';
import { type Connector } from '@metro-labs/client/api/connectors';
import { type Server } from '@metro-labs/client/api/servers';
import { useClaudeSessionQuery, useServerStatus } from '../lib/queries.js';
import { type ClaudeSessionStatus } from '@metro-labs/client/api/claude-box';
import { routeHash } from '@metro-labs/client/route';
import { RouteLink } from './RouteLink.js';
import { RoundButton } from './RoundButton.js';
import { openExternal } from '../lib/open.js';
import { type Selection } from '@metro-labs/client/selection';

const PAGE_AVATAR = 56;
const CONNECTOR_ICON = 18;
const CHAT_ICON = 18;
const CHIP = { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5, paddingLeft: 8, paddingRight: 12, borderWidth: 1, borderRadius: 999 } as const;

export function AgentPicture({ server, seed }: { server: Server | undefined; seed: string }): ReactNode {
  if (server === undefined) return <AgentAvatar seed={seed} size={PAGE_AVATAR} />;
  return <AgentAvatar seed={server.host} src={server.avatar} size={PAGE_AVATAR} />;
}

interface Status {
  text: string;
  tone: 'good' | 'idle' | 'bad';
  fix?: Selection;
}

function statusOf(state: string | undefined, session: ClaudeSessionStatus | undefined, project: string): Status {
  if (state === undefined) return { text: 'Checking…', tone: 'idle' };
  if (state === 'stopped') return { text: 'Stopped. Start it again from Settings, Server.', tone: 'bad', fix: { kind: 'server', project } };
  if (state !== 'live') return { text: 'Offline. The server does not answer.', tone: 'bad' };
  if (session === undefined) return { text: 'Online', tone: 'good' };
  if (session.running) return { text: 'Online and ready', tone: 'good' };
  if (session.blocked !== null) return { text: `Online, but not ready: ${session.blocked}`, tone: 'bad', fix: { kind: 'claude', project } };
  return { text: 'Online, but Claude Code is not running', tone: 'bad', fix: { kind: 'claude', project } };
}

export function StatusLine({ host, project }: { host: string | null; project: string }): ReactNode {
  const palette = useKitPalette();
  const status = useServerStatus(host ?? '');
  const session = useClaudeSessionQuery();
  const { text, tone, fix } = statusOf(host === null ? undefined : status.data?.state, session.data, project);
  const dot = tone === 'good' ? palette.success : tone === 'bad' ? palette.danger : palette.sub;
  const body = (
    <Row align="center" gap={8}>
      <Row width={8} height={8} radius={4} background={dot} />
      <Text size="xs" role={tone === 'bad' ? 'danger' : 'secondary'}>
        {text}
      </Text>
    </Row>
  );
  if (fix === undefined) return body;
  return (
    <RouteLink to={routeHash(fix)} label={text} style={SELF}>
      {body}
    </RouteLink>
  );
}

const SELF = { alignSelf: 'flex-start' } as const;

export function ChannelCards({ groups, project }: { groups: AccountGroup[]; project: string }): ReactNode {
  const palette = useKitPalette();
  const accounts = flattenAccounts(groups).filter((a) => a.row.id !== null);
  if (accounts.length === 0)
    return (
      <Text size="2xs" role="secondary">
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

export function ConnectorIcons({ connectors, project }: { connectors: Connector[]; project: string }): ReactNode {
  const palette = useKitPalette();
  const chip = [CHIP, { borderColor: palette.border }];
  const hover = { backgroundColor: palette.inputBg };
  if (connectors.length === 0)
    return (
      <Text size="2xs" role="secondary">
        No connector yet.
      </Text>
    );
  return (
    <Row gap={8} wrap>
      {connectors.map((c) => {
        const target: Selection = { kind: 'connector', project, id: c.id };
        return (
          <RouteLink key={c.id} to={routeHash(target)} label={c.name} style={chip} hoverStyle={hover}>
            <ConnectorFavicon name={c.name} url={c.url} size={CONNECTOR_ICON} />
            <Text size="2xs" numberOfLines={1}>
              {c.name}
            </Text>
          </RouteLink>
        );
      })}
    </Row>
  );
}
