import { type MouseEvent, type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { BLOCK_RADIUS_DEFAULT } from '@stage-labs/kit/tokens';
import { useQueryClient } from '@tanstack/react-query';
import { Text, Button } from './ui.js';
import { SHRINK } from '../theme.js';
import { PageTitle } from './PageTitle.js';
import { Pill } from './Pill.js';
import { KebabMenu } from './KebabMenu.js';
import { Loading } from './Loading.js';
import { Frame } from './Frame.js';
import { PlainSidebar } from './PlainSidebar.js';
import { opensElsewhere } from './link.js';
import { removeServer, serverLabel, type Server } from '../api/servers.js';
import { awaitLive, startDaemon } from '../api/control.js';
import { queryError, refreshServers, refreshServerStatus, useServersQuery, useServerStatus } from '../api/queries.js';
import { StatusDot } from './StatusDot.js';
import { baseFromSegment } from '../auth/daemon.js';
import { activeAccount } from '../auth/account.js';
import { routeHash } from '../route.js';
import { useDocumentTitle } from '../title.js';
import { useBootingState } from '../aws/use-launch.js';
import { BootLog } from './BootLog.js';
import { AgentAvatar } from './AgentAvatar.js';

const LIST_WIDTH = 880;
const CARD_AVATAR = 48;
const CARD_MIN = 220;
const CARD_MAX = 300;
const HOW = 'Every agent you open lands here, on every device you sign in from. Open one, or add the address its daemon printed.';

function StatusText({ server }: { server: Server }): ReactNode {
  const { data } = useServerStatus(server.host);
  const booting = useBootingState(server, data?.state === 'offline');
  if (data === undefined) return <Pill label="Checking" />;
  if (data.state === 'offline') return <Pill label={booting === null ? 'Offline' : `Booting · ${booting}`} />;
  if (data.state === 'stopped') return <Pill label="Stopped" />;
  return <Pill label={data.version === null ? 'Live' : `Live · ${data.version}`} variant="primary" />;
}

function StartButton({ host }: { host: string }): ReactNode {
  const client = useQueryClient();
  const dark = useKitScheme() === 'dark';
  const { data } = useServerStatus(host);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (data?.state !== 'stopped' && !busy) return null;
  const start = (): void => {
    const base = baseFromSegment(host);
    setBusy(true);
    setError(null);
    startDaemon(base)
      .then(() => awaitLive(base))
      .then(() => refreshServerStatus(client, host))
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not start metro.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <Row gap={8} align="center">
      {error !== null ? (
        <Text size="sm" role="danger" numberOfLines={1}>
          {error}
        </Text>
      ) : null}
      <Button size="sm" color="secondary" dark={dark} label={busy ? 'Starting…' : 'Start'} loading={busy} disabled={busy} onPress={start} />
    </Row>
  );
}

interface CardProps {
  server: Server;
  onRemove: () => void;
  onBootLog: () => void;
}

function AgentCard({ server, onRemove, onBootLog }: CardProps): ReactNode {
  const palette = useKitPalette();
  const side = { width: 1, color: palette.border };
  const href = `#/${server.id}`;
  const launched = server.instanceId !== null;
  const open = (e: MouseEvent<HTMLAnchorElement>): void => {
    if (opensElsewhere(e)) return;
    e.preventDefault();
    window.location.hash = href;
  };
  return (
    <Col gap={12} padding={16} flex={1} minWidth={CARD_MIN} maxWidth={CARD_MAX} radius={BLOCK_RADIUS_DEFAULT} border={{ top: side, right: side, bottom: side, left: side }}>
      <Row justify="between" align="start" gap={8}>
        <a className="card-link" href={href} onClick={open}>
          <AgentAvatar seed={server.host} src={server.avatar} size={CARD_AVATAR} />
        </a>
        <KebabMenu
          label={`Agent menu for ${serverLabel(server)}`}
          items={[...(launched ? [{ label: 'Boot log', onSelect: onBootLog }] : []), { label: 'Remove', danger: true, onSelect: onRemove }]}
        />
      </Row>
      <a className="card-link" href={href} onClick={open}>
        <Col gap={2}>
          <Row gap={8} align="center">
            <StatusDot host={server.host} />
            <Text size="md" weight="semibold" numberOfLines={1} style={SHRINK}>
              {serverLabel(server)}
            </Text>
          </Row>
          <Text size="sm" role="secondary" numberOfLines={1}>
            {server.host}
          </Text>
        </Col>
      </a>
      <Row gap={8} align="center" wrap>
        <StatusText server={server} />
        <StartButton host={server.host} />
      </Row>
    </Col>
  );
}

interface ListProps {
  servers: Server[];
  onBootLog: (s: Server) => void;
}

function ServerList({ servers, onBootLog }: ListProps): ReactNode {
  const client = useQueryClient();
  if (servers.length === 0)
    return (
      <Text size="sm" role="secondary">
        No agents yet. Add the address your daemon printed at start-up.
      </Text>
    );
  return (
    <Row gap={12} wrap>
      {servers.map((server) => (
        <AgentCard
          key={server.id}
          server={server}
          onBootLog={() => {
            onBootLog(server);
          }}
          onRemove={() => {
            removeServer(server.id)
              .then(() => refreshServers(client))
              .catch(() => undefined);
          }}
        />
      ))}
    </Row>
  );
}

function Body({ onBootLog }: { onBootLog: (s: Server) => void }): ReactNode {
  const { data, error, isPending } = useServersQuery();
  if (isPending) return <Loading />;
  if (error !== null)
    return (
      <Text size="sm" role="danger">
        {queryError(error, 'Could not list your agents.')}
      </Text>
    );
  return <ServerList servers={data} onBootLog={onBootLog} />;
}

export function Servers({ onLock }: { onLock: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [logOf, setLogOf] = useState<Server | null>(null);
  const subject = activeAccount()?.user.id ?? '';
  useDocumentTitle('Agents');
  return (
    <Frame
      selection={{ kind: 'servers' }}
      sidebar={(closeMenu) => (
        <PlainSidebar
          selection={{ kind: 'servers' }}
          subject={subject}
          onSelect={(next) => {
            closeMenu();
            window.location.hash = routeHash(next);
          }}
          onLock={onLock}
        />
      )}
    >
      <Col gap={20} width="100%" maxWidth={LIST_WIDTH}>
        <PageTitle>Agents</PageTitle>
        <Text size="sm" role="secondary">
          {HOW}
        </Text>
        <Body onBootLog={setLogOf} />
        <Row gap={12} wrap>
          <Button
            color="primary"
            dark={dark}
            label="Add an agent"
            onPress={() => {
              window.location.hash = '#/connect';
            }}
          />
          <Button
            color="secondary"
            dark={dark}
            label="New agent"
            onPress={() => {
              window.location.hash = '#/launch';
            }}
          />
        </Row>
        <BootLog
          server={logOf}
          onClose={() => {
            setLogOf(null);
          }}
        />
      </Col>
    </Frame>
  );
}
