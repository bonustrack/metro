import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { BLOCK_RADIUS_DEFAULT } from '@stage-labs/kit/tokens';
import { useQueryClient } from '@tanstack/react-query';
import { Text, Button } from './ui.js';
import { GROW, SHRINK } from '../theme.js';
import { MetroLogo } from './MetroLogo.js';
import { PageTitle } from './PageTitle.js';
import { Pill } from './Pill.js';
import { KebabMenu } from './KebabMenu.js';
import { NameModal } from './NameModal.js';
import { Dropdown } from './Dropdown.js';
import { AgentAvatar } from './AgentAvatar.js';
import { Loading } from './Loading.js';
import { opensElsewhere } from './link.js';
import { removeServer, renameServer, serverLabel, type Server } from '../api/servers.js';
import { awaitLive, startDaemon } from '../api/control.js';
import { queryError, refreshServers, refreshServerStatus, useServersQuery, useServerStatus } from '../api/queries.js';
import { baseFromSegment } from '../auth/daemon.js';
import { shortAddress } from '../api/address.js';
import { activeIdentity } from '../auth/identity.js';
import { useDocumentTitle } from '../title.js';
import { useBootingState } from '../aws/use-launch.js';
import { launches } from '../aws/settings.js';
import { BootLog } from './BootLog.js';

const CARD_WIDTH = 640;
const DOT = 8;
const HOW = 'Every daemon you open lands here, on every device you sign in from. Open one, or add the address a daemon printed.';

function StatusDot({ host }: { host: string }): ReactNode {
  const palette = useKitPalette();
  const { data } = useServerStatus(host);
  const color =
    data === undefined ? palette.border : data.state === 'live' ? palette.success : data.state === 'stopped' ? palette.danger : palette.sub;
  return <Row width={DOT} height={DOT} radius={DOT} background={color} />;
}

function StatusText({ host }: { host: string }): ReactNode {
  const { data } = useServerStatus(host);
  const booting = useBootingState(host, data?.state === 'offline');
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

interface RowProps {
  server: Server;
  last: boolean;
  onRename: () => void;
  onRemove: () => void;
  onBootLog: () => void;
}

function ServerRow({ server, last, onRename, onRemove, onBootLog }: RowProps): ReactNode {
  const palette = useKitPalette();
  const href = `#/${server.id}`;
  const launched = launches()[server.host] !== undefined;
  return (
    <Row
      align="center"
      gap={12}
      padding={{ x: 14, y: 12 }}
      border={last ? undefined : { bottom: { width: 1, color: palette.border } }}
    >
      <StatusDot host={server.host} />
      <a
        className="row-link"
        href={href}
        style={GROW}
        onClick={(e) => {
          if (opensElsewhere(e)) return;
          e.preventDefault();
          window.location.hash = href;
        }}
      >
        <Col style={SHRINK}>
          <Text size="md" weight="semibold" numberOfLines={1}>
            {serverLabel(server)}
          </Text>
          {server.name === null ? null : (
            <Text size="sm" role="secondary" numberOfLines={1}>
              {server.host}
            </Text>
          )}
        </Col>
      </a>
      <StatusText host={server.host} />
      <StartButton host={server.host} />
      <KebabMenu
        label={`Server menu for ${serverLabel(server)}`}
        items={[
          { label: server.name === null ? 'Name' : 'Rename', onSelect: onRename },
          ...(launched ? [{ label: 'Boot log', onSelect: onBootLog }] : []),
          { label: 'Remove', danger: true, onSelect: onRemove },
        ]}
      />
    </Row>
  );
}

interface ListProps {
  servers: Server[];
  onRename: (s: Server) => void;
  onBootLog: (s: Server) => void;
}

function ServerList({ servers, onRename, onBootLog }: ListProps): ReactNode {
  const palette = useKitPalette();
  const client = useQueryClient();
  const side = { width: 1, color: palette.border };
  if (servers.length === 0)
    return (
      <Text size="sm" role="secondary">
        No servers yet. Add the address your daemon printed at start-up.
      </Text>
    );
  return (
    <Col radius={BLOCK_RADIUS_DEFAULT} border={{ top: side, right: side, bottom: side, left: side }}>
      {servers.map((server, index) => (
        <ServerRow
          key={server.id}
          server={server}
          last={index === servers.length - 1}
          onRename={() => {
            onRename(server);
          }}
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
    </Col>
  );
}

function Header({ onLock }: { onLock: () => void }): ReactNode {
  const palette = useKitPalette();
  const subject = activeIdentity()?.address ?? '';
  return (
    <Row justify="between" align="center" gap={12}>
      <Row align="center" gap={12}>
        <MetroLogo size={32} color={palette.link} />
        <PageTitle>Servers</PageTitle>
      </Row>
      <Dropdown className="account-trigger" label="Account menu" items={[{ label: 'Log out', danger: true, onSelect: onLock }]}>
        <Row align="center" gap={8}>
          <AgentAvatar seed={subject} size={20} />
          <Text size="sm" role="secondary">
            {shortAddress(subject)}
          </Text>
        </Row>
      </Dropdown>
    </Row>
  );
}

function RenameServer({ server, onClose }: { server: Server | null; onClose: () => void }): ReactNode {
  const client = useQueryClient();
  return (
    <NameModal
      title={server?.name === null ? 'Name this server' : 'Rename this server'}
      action="Save"
      placeholder={server?.host ?? ''}
      initial={server?.name ?? ''}
      failure="Could not save the name."
      open={server !== null}
      onClose={onClose}
      onSubmit={async (name) => {
        if (server === null) return null;
        const saved = await renameServer(server.id, name);
        await refreshServers(client);
        return saved;
      }}
    />
  );
}

function Body({ onRename, onBootLog }: { onRename: (s: Server) => void; onBootLog: (s: Server) => void }): ReactNode {
  const { data, error, isPending } = useServersQuery();
  if (isPending) return <Loading />;
  if (error !== null)
    return (
      <Text size="sm" role="danger">
        {queryError(error, 'Could not list your servers.')}
      </Text>
    );
  return <ServerList servers={data} onRename={onRename} onBootLog={onBootLog} />;
}

export function Servers({ onLock }: { onLock: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [renaming, setRenaming] = useState<Server | null>(null);
  const [logOf, setLogOf] = useState<Server | null>(null);
  useDocumentTitle('Servers');
  return (
    <Row justify="center" flex={1} padding={24}>
      <Col gap={20} width="100%" maxWidth={CARD_WIDTH} padding={{ top: 24 }}>
        <Header onLock={onLock} />
        <Text size="sm" role="secondary">
          {HOW}
        </Text>
        <Body onRename={setRenaming} onBootLog={setLogOf} />
        <Row gap={12} wrap>
          <Button
            color="primary"
            dark={dark}
            label="Add a server"
            onPress={() => {
              window.location.hash = '#/connect';
            }}
          />
          <Button
            color="secondary"
            dark={dark}
            label="Launch on AWS"
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
        <RenameServer
          server={renaming}
          onClose={() => {
            setRenaming(null);
          }}
        />
      </Col>
    </Row>
  );
}
