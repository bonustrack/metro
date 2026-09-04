import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import {
  useKitPalette,
  useKitScheme,
} from '@stage-labs/kit/react-native/theme-context';
import { BLOCK_RADIUS_DEFAULT } from '@stage-labs/kit/tokens';
import { Text, Button, Input } from './ui';
import { GROW } from '../theme';
import { MetroLogo } from './MetroLogo';
import { PageTitle } from './PageTitle';
import { connectRefusal, fetchMode } from '../api/mode';
import {
  builtInDaemon,
  daemonHost,
  parseDaemonUrl,
  storeDaemon,
  storedDaemon,
} from '../auth/daemon';
import { goToDaemon, knownDaemons, rememberDaemon, type KnownDaemon } from '../auth/daemons';

const CARD_WIDTH = 400;
const HINT =
  'A Metro daemon running on your own machine serves these same pages, and your messages never leave it. Paste the address it printed at start-up, usually http://127.0.0.1:8420. From another computer, forward its port first: ssh -L 8420:127.0.0.1:8420 <host>.';

function switchTo(base: string): void {
  storeDaemon(base);
  rememberDaemon(base);
  goToDaemon(base);
}

function KnownServers({ servers, current }: { servers: KnownDaemon[]; current: string }): ReactNode {
  const dark = useKitScheme() === 'dark';
  if (servers.length === 0) return null;
  return (
    <Col gap={8}>
      <Text size="sm" role="secondary">
        Servers this browser knows
      </Text>
      {servers.map((server) => (
        <Row key={server.base} justify="between" align="center" gap={12}>
          <Col style={GROW}>
            <Text size="md" numberOfLines={1}>
              {server.name ?? daemonHost(server.base)}
            </Text>
            {server.name === null ? null : (
              <Text size="sm" role="secondary" numberOfLines={1}>
                {daemonHost(server.base)}
              </Text>
            )}
          </Col>
          {server.base === current ? (
            <Text size="sm" role="secondary">
              current
            </Text>
          ) : (
            <Button
              color="secondary"
              dark={dark}
              label="Open"
              onPress={() => {
                switchTo(server.base);
              }}
            />
          )}
        </Row>
      ))}
    </Col>
  );
}

export function Connect(): ReactNode {
  const dark = useKitScheme() === 'dark';
  const palette = useKitPalette();
  const [value, setValue] = useState(storedDaemon() ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const side = { width: 1, color: palette.border };
  const current = storedDaemon() ?? builtInDaemon();

  const connect = (): void => {
    if (busy) return;
    const target = parseDaemonUrl(value);
    if ('error' in target) {
      setError(target.error);
      return;
    }
    setBusy(true);
    setError(null);
    fetchMode(target.base)
      .then((info) => {
        const refused = connectRefusal(info);
        if (refused !== null) {
          setError(refused);
          setBusy(false);
          return;
        }
        switchTo(target.base);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not reach that daemon.');
        setBusy(false);
      });
  };

  return (
    <Row justify="center" align="center" flex={1} padding={24}>
      <Col
        gap={20}
        width="100%"
        maxWidth={CARD_WIDTH}
        padding={24}
        radius={BLOCK_RADIUS_DEFAULT}
        border={{ top: side, right: side, bottom: side, left: side }}
      >
        <Row justify="center">
          <MetroLogo size={48} color={palette.link} />
        </Row>
        <Row justify="center">
          <PageTitle>Connect to a daemon</PageTitle>
        </Row>
        <Text size="sm" role="secondary">
          {HINT}
        </Text>
        <Input
          name="daemon"
          value={value}
          placeholder="http://127.0.0.1:8420"
          disabled={busy}
          dark={dark}
          onChangeText={setValue}
          onSubmit={connect}
          style={GROW}
        />
        {error === null ? null : (
          <Text size="sm" role="danger">
            {error}
          </Text>
        )}
        <Row justify="between" align="center" gap={12} wrap>
          <Button
            color="primary"
            dark={dark}
            loading={busy}
            label="Connect"
            onPress={connect}
          />
        </Row>
        <Text size="sm" role="secondary">
          {current === builtInDaemon()
            ? 'This page is not connected to a daemon yet.'
            : `This page currently talks to ${daemonHost(current)}.`}
        </Text>
        <KnownServers servers={knownDaemons()} current={current} />
      </Col>
    </Row>
  );
}
