import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { Badge } from '@stage-labs/kit/react-native/badge';
import { removeServer, serverLabel, type Server } from '@metro-labs/client/api/servers';
import { awaitLive, startDaemon } from '@metro-labs/client/api/control';
import { baseFromSegment } from '@metro-labs/client/auth/daemon';
import { routeHash } from '@metro-labs/client/route';
import { ListHeader } from './ListHeader.js';
import { ListRow } from './ListRow.js';
import { RowDots } from './RowDots.js';
import { Loading } from './Loading.js';
import { Frame } from './Shell.js';
import { PlainSidebar } from './PlainSidebar.js';
import { StatusDot } from './StatusDot.js';
import { BootLog } from './BootLog.js';
import { AgentAvatar } from './AgentAvatar.js';
import { LatestUsageLine } from './LatestUsage.js';
import { queryError, refreshServers, refreshServerStatus, useServersQuery, useServerStatus } from '../lib/queries.js';
import { useBootingState } from '../lib/use-launch.js';
import { useDocumentTitle } from '../lib/title.js';
import { go } from '../lib/nav.js';
import { useIsNarrow } from '../lib/media.js';


function StatusText({ server }: { server: Server }): ReactNode {
  const { data } = useServerStatus(server.host);
  const booting = useBootingState(server, data?.state === 'offline');
  if (data === undefined) return <Badge label="Checking" color="secondary" variant="soft" />;
  if (data.state === 'updating') return <Badge label="Updating" color="secondary" variant="soft" />;
  if (data.state === 'offline') return <Badge label={booting === null ? 'Offline' : `Booting · ${booting}`} color="secondary" variant="soft" />;
  if (data.state === 'stopped') return <Badge label="Stopped" color="secondary" variant="soft" />;
  return <Badge label={data.version === null ? 'Live' : `Live · ${data.version}`} color="success" variant="soft" />;
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
        <Text size="md" role="danger" numberOfLines={1}>
          {error}
        </Text>
      ) : null}
      <Button size="md" color="secondary" dark={dark} label={busy ? 'Starting…' : 'Start'} loading={busy} disabled={busy} onPress={start} />
    </Row>
  );
}

const AVATAR = 32;

function AgentRow({ server, narrow, onRemove, onBootLog }: { server: Server; narrow: boolean; onRemove: () => void; onBootLog: () => void }): ReactNode {
  const launched = server.instanceId !== null;
  const items = [...(launched ? [{ label: 'Boot log', onSelect: onBootLog }] : []), { label: 'Remove', danger: true, onSelect: onRemove }];
  return (
    <ListRow
      title={serverLabel(server)}
      label={`Open ${serverLabel(server)}`}
      detail={server.host}
      href={routeHash({ kind: 'home', project: server.id })}
      highlight={false}
      icon={<AgentAvatar seed={server.host} src={server.avatar} size={AVATAR} />}
      extra={<StatusDot host={server.host} />}
      trailing={
        <Row gap={12} align="center">
          {narrow ? null : <LatestUsageLine serverId={server.id} />}
          <StatusText server={server} />
          <StartButton host={server.host} />
          <RowDots items={items} label={`Agent menu for ${serverLabel(server)}`} />
        </Row>
      }
    />
  );
}

function ServerList({ servers, onBootLog }: { servers: Server[]; onBootLog: (s: Server) => void }): ReactNode {
  const client = useQueryClient();
  const narrow = useIsNarrow();
  const [failed, setFailed] = useState<string | null>(null);
  if (servers.length === 0)
    return (
      <Text size="md" role="secondary">
        No agents yet. Add the address Metro printed when it started.
      </Text>
    );
  const remove = (server: Server): void => {
    setFailed(null);
    removeServer(server.id)
      .catch((err: unknown) => {
        setFailed(`Could not remove ${serverLabel(server)}: ${queryError(err, 'Metro did not answer.')}`);
      })
      .then(() => refreshServers(client))
      .catch((err: unknown) => {
        setFailed(queryError(err, 'Could not list your agents.'));
      });
  };
  return (
    <>
      {failed === null ? null : (
        <Text size="md" role="danger">
          {failed}
        </Text>
      )}
      <Col>
        {servers.map((server) => (
          <AgentRow
            key={server.id}
            server={server}
            narrow={narrow}
            onBootLog={() => {
              onBootLog(server);
            }}
            onRemove={() => {
              remove(server);
            }}
          />
        ))}
      </Col>
    </>
  );
}

function Body({ onBootLog }: { onBootLog: (s: Server) => void }): ReactNode {
  const { data, error, isPending } = useServersQuery();
  if (isPending) return <Loading />;
  if (error !== null)
    return (
      <Text size="md" role="danger">
        {queryError(error, 'Could not list your agents.')}
      </Text>
    );
  return <ServerList servers={data} onBootLog={onBootLog} />;
}

export function Servers({ onLock }: { onLock: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [logOf, setLogOf] = useState<Server | null>(null);
  useDocumentTitle('Agents');
  return (
    <Frame sidebar={(closeMenu) => <PlainSidebar selection={{ kind: 'servers' }} onSelect={closeMenu} />} onLock={onLock}>
      <Col gap={12} width="100%">
        <ListHeader
          title="Agents"
          rule={false}
          action={
            <Button
              color="primary"
              dark={dark}
              label="New agent"
              onPress={() => {
                go({ kind: 'launch' });
              }}
            />
          }
        />
        <Body onBootLog={setLogOf} />
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
