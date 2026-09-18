import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { BLOCK_RADIUS_DEFAULT } from '@stage-labs/kit/tokens';
import { useQueryClient } from '@tanstack/react-query';
import { Text, Button } from './ui.js';
import { GROW, SHRINK } from '../theme.js';
import { PageTitle } from './PageTitle.js';
import { Pill } from './Pill.js';
import { KebabMenu } from './KebabMenu.js';
import { NameModal } from './NameModal.js';
import { Loading } from './Loading.js';
import { Frame } from './Frame.js';
import { PlainSidebar } from './PlainSidebar.js';
import { opensElsewhere } from './link.js';
import { removeServer, renameServer, serverLabel, type Server } from '../api/servers.js';
import { awaitLive, startDaemon } from '../api/control.js';
import { queryError, refreshServers, refreshServerStatus, useServersQuery, useServerStatus } from '../api/queries.js';
import { StatusDot } from './StatusDot.js';
import { baseFromSegment } from '../auth/daemon.js';
import { activeIdentity } from '../auth/identity.js';
import { routeHash } from '../route.js';
import { useDocumentTitle } from '../title.js';
import { useBootingState } from '../aws/use-launch.js';
import { BootLog } from './BootLog.js';
import { AgentAvatar } from './AgentAvatar.js';
import { useAvatarPicker } from './AvatarPicker.js';
import { ClaimServers } from './ClaimServers.js';

const LIST_WIDTH = 640;
const ROW_AVATAR = 32;
const HOW = 'Every daemon you open lands here, on every device you sign in from. Open one, or add the address a daemon printed.';

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

interface RowProps {
  server: Server;
  last: boolean;
  onRename: () => void;
  onRemove: () => void;
  onBootLog: () => void;
}

function ServerRow({ server, last, onRename, onRemove, onBootLog }: RowProps): ReactNode {
  const palette = useKitPalette();
  const avatar = useAvatarPicker(server);
  const href = `#/${server.id}`;
  const launched = server.instanceId !== null;
  return (
    <Row
      align="center"
      gap={12}
      padding={{ x: 14, y: 12 }}
      border={last ? undefined : { bottom: { width: 1, color: palette.border } }}
    >
      <AgentAvatar seed={server.host} src={server.avatar} size={ROW_AVATAR} />
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
      {avatar.error !== null ? (
        <Text size="sm" role="danger" numberOfLines={1}>
          {avatar.error}
        </Text>
      ) : null}
      <StatusText server={server} />
      <StartButton host={server.host} />
      {avatar.input}
      <KebabMenu
        label={`Server menu for ${serverLabel(server)}`}
        items={[
          { label: server.name === null ? 'Name' : 'Rename', onSelect: onRename },
          { label: avatar.busy ? 'Saving avatar…' : 'Set avatar', onSelect: avatar.pick },
          ...(server.avatar === null ? [] : [{ label: 'Remove avatar', onSelect: avatar.remove }]),
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
      <Col gap={16}>
        <Text size="sm" role="secondary">
          No servers yet. Add the address your daemon printed at start-up.
        </Text>
        <ClaimServers />
      </Col>
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
  const subject = activeIdentity()?.address ?? '';
  useDocumentTitle('Servers');
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
        <PageTitle>Servers</PageTitle>
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
        <RenameServer
          server={renaming}
          onClose={() => {
            setRenaming(null);
          }}
        />
      </Col>
    </Frame>
  );
}
