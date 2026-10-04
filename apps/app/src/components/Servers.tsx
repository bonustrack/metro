import { type ReactNode, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { BLOCK_RADIUS_DEFAULT } from '@stage-labs/kit/tokens';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { Badge } from '@stage-labs/kit/react-native/badge';
import { removeServer, serverLabel, type Server } from '@metro-labs/client/api/servers';
import { awaitLive, startDaemon } from '@metro-labs/client/api/control';
import { baseFromSegment } from '@metro-labs/client/auth/daemon';
import { routeHash } from '@metro-labs/client/route';
import { ListHeader } from './ListHeader.js';
import { KebabMenu } from './KebabMenu.js';
import { Loading } from './Loading.js';
import { Frame } from './Shell.js';
import { PlainSidebar } from './PlainSidebar.js';
import { StatusDot } from './StatusDot.js';
import { BootLog } from './BootLog.js';
import { AgentAvatar } from './AgentAvatar.js';
import { LatestUsageLine } from './LatestUsage.js';
import { RouteLink } from './RouteLink.js';
import { Grid } from './ui/Grid.js';
import { allSides } from './ui/edges.js';
import { queryError, refreshServers, refreshServerStatus, useServersQuery, useServerStatus } from '../lib/queries.js';
import { useBootingState } from '../lib/use-launch.js';
import { useDocumentTitle } from '../lib/title.js';
import { go } from '../lib/nav.js';
import { ABSOLUTE_FILL, SHRINK } from '../lib/style.js';

const LIST_WIDTH = 880;
const CARD_AVATAR = 44;
const CARD_MIN = 240;
const CARD_HEIGHT = 176;
const HOW = 'Each agent runs on its own server. Open one to manage its channels, memory and settings.';

const styles = StyleSheet.create({
  card: { position: 'relative', minHeight: CARD_HEIGHT, borderRadius: BLOCK_RADIUS_DEFAULT },
  cover: { ...ABSOLUTE_FILL, borderRadius: BLOCK_RADIUS_DEFAULT },
  dashed: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderStyle: 'dashed' },
});

function StatusText({ server }: { server: Server }): ReactNode {
  const { data } = useServerStatus(server.host);
  const booting = useBootingState(server, data?.state === 'offline');
  if (data === undefined) return <Badge label="Checking" color="secondary" variant="soft" pill />;
  if (data.state === 'offline') return <Badge label={booting === null ? 'Offline' : `Booting · ${booting}`} color="secondary" variant="soft" pill />;
  if (data.state === 'stopped') return <Badge label="Stopped" color="secondary" variant="soft" pill />;
  return <Badge label={data.version === null ? 'Live' : `Live · ${data.version}`} color="success" variant="soft" pill />;
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
        <Text size="2xs" role="danger" numberOfLines={1}>
          {error}
        </Text>
      ) : null}
      <Button size="md" color="secondary" dark={dark} label={busy ? 'Starting…' : 'Start'} loading={busy} disabled={busy} onPress={start} />
    </Row>
  );
}

function AgentCard({ server, onRemove, onBootLog }: { server: Server; onRemove: () => void; onBootLog: () => void }): ReactNode {
  const palette = useKitPalette();
  const launched = server.instanceId !== null;
  const hover = { backgroundColor: palette.inputBg };
  return (
    <View style={styles.card}>
      <RouteLink to={routeHash({ kind: 'home', project: server.id })} label={`Open ${serverLabel(server)}`} style={styles.cover} hoverStyle={hover}>
        {null}
      </RouteLink>
      <Col pointerEvents="box-none" gap={14} padding={16} flex={1} radius={BLOCK_RADIUS_DEFAULT} border={allSides(palette.border)}>
        <Row pointerEvents="box-none" justify="between" align="start" gap={8}>
          <View pointerEvents="none">
            <AgentAvatar seed={server.host} src={server.avatar} size={CARD_AVATAR} />
          </View>
          <KebabMenu label={`Agent menu for ${serverLabel(server)}`} items={[...(launched ? [{ label: 'Boot log', onSelect: onBootLog }] : []), { label: 'Remove', danger: true, onSelect: onRemove }]} />
        </Row>
        <Col pointerEvents="none" gap={2} flex={1}>
          <Row gap={8} align="center">
            <StatusDot host={server.host} />
            <Text size="md" weight="semibold" numberOfLines={1} style={SHRINK}>
              {serverLabel(server)}
            </Text>
          </Row>
          <Text size="2xs" role="secondary" numberOfLines={1}>
            {server.host}
          </Text>
          <LatestUsageLine serverId={server.id} />
        </Col>
        <Row pointerEvents="box-none" gap={8} align="center" wrap>
          <View pointerEvents="none">
            <StatusText server={server} />
          </View>
          <StartButton host={server.host} />
        </Row>
      </Col>
    </View>
  );
}

function NewAgentCard(): ReactNode {
  const palette = useKitPalette();
  const hover = { backgroundColor: palette.inputBg };
  const frame = [styles.card, styles.dashed, { borderColor: palette.border }];
  return (
    <RouteLink to={routeHash({ kind: 'launch' })} label="New agent" style={frame} hoverStyle={hover}>
      <Text size="xs" weight="medium" role="secondary">
        + New agent
      </Text>
    </RouteLink>
  );
}

function ServerList({ servers, onBootLog }: { servers: Server[]; onBootLog: (s: Server) => void }): ReactNode {
  const client = useQueryClient();
  const [failed, setFailed] = useState<string | null>(null);
  if (servers.length === 0)
    return (
      <Text size="2xs" role="secondary">
        No agents yet. Add the address your daemon printed at start-up.
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
        <Text size="2xs" role="danger">
          {failed}
        </Text>
      )}
      <Grid min={CARD_MIN} gap={16}>
        {servers.map((server) => (
          <AgentCard
            key={server.id}
            server={server}
            onBootLog={() => {
              onBootLog(server);
            }}
            onRemove={() => {
              remove(server);
            }}
          />
        ))}
        <NewAgentCard />
      </Grid>
    </>
  );
}

function Body({ onBootLog }: { onBootLog: (s: Server) => void }): ReactNode {
  const { data, error, isPending } = useServersQuery();
  if (isPending) return <Loading />;
  if (error !== null)
    return (
      <Text size="2xs" role="danger">
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
      <Col gap={20} width="100%">
        <ListHeader
          title="Agents"
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
        <Col gap={20} width="100%" maxWidth={LIST_WIDTH}>
          <Text size="2xs" role="secondary">
            {HOW}
          </Text>
          <Body onBootLog={setLogOf} />
        </Col>
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
