import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { BLOCK_RADIUS_DEFAULT } from '@stage-labs/kit/tokens';
import { useQueryClient } from '@tanstack/react-query';
import { Text, Button } from './ui';
import { GROW, SHRINK } from '../theme';
import { MetroLogo } from './MetroLogo';
import { PageTitle } from './PageTitle';
import { Pill } from './Pill';
import { KebabMenu } from './KebabMenu';
import { NameModal } from './NameModal';
import { Dropdown } from './Dropdown';
import { AgentAvatar } from './AgentAvatar';
import { Loading } from './Loading';
import { opensElsewhere } from './link';
import { removeServer, renameServer, serverLabel, type Server } from '../api/servers';
import { awaitLive, startDaemon } from '../api/control';
import { queryError, refreshServers, refreshServerStatus, useServersQuery, useServerStatus } from '../api/queries';
import { baseFromSegment } from '../auth/daemon';
import { shortAddress } from '../api/address';
import { activeIdentity } from '../auth/identity';
import { useDocumentTitle } from '../title';

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
  if (data === undefined) return <Pill label="Checking" />;
  if (data.state === 'offline') return <Pill label="Offline" />;
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
}

function ServerRow({ server, last, onRename, onRemove }: RowProps): ReactNode {
  const palette = useKitPalette();
  const href = `#/${server.id}`;
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
          { label: 'Remove', danger: true, onSelect: onRemove },
        ]}
      />
    </Row>
  );
}

function ServerList({ servers, onRename }: { servers: Server[]; onRename: (s: Server) => void }): ReactNode {
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

function Body({ onRename }: { onRename: (s: Server) => void }): ReactNode {
  const { data, error, isPending } = useServersQuery();
  if (isPending) return <Loading />;
  if (error !== null)
    return (
      <Text size="sm" role="danger">
        {queryError(error, 'Could not list your servers.')}
      </Text>
    );
  return <ServerList servers={data} onRename={onRename} />;
}

export function Servers({ onLock }: { onLock: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [renaming, setRenaming] = useState<Server | null>(null);
  useDocumentTitle('Servers');
  return (
    <Row justify="center" flex={1} padding={24}>
      <Col gap={20} width="100%" maxWidth={CARD_WIDTH} padding={{ top: 24 }}>
        <Header onLock={onLock} />
        <Text size="sm" role="secondary">
          {HOW}
        </Text>
        <Body onRename={setRenaming} />
        <Row>
          <Button
            color="primary"
            dark={dark}
            label="Add a server"
            onPress={() => {
              window.location.hash = '#/connect';
            }}
          />
        </Row>
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
