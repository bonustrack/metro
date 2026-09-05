import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';
import { awaitLive, startDaemon } from '../api/control';
import { queryError } from '../api/queries';
import { daemonBase, daemonHost } from '../auth/daemon';

const NOTICE_WIDTH = 480;
const CENTER_SELF = { alignSelf: 'center' } as const;

export function StoppedNotice({ onStarted }: { onStarted: () => void }): ReactNode {
  const client = useQueryClient();
  const dark = useKitScheme() === 'dark';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = (): void => {
    setBusy(true);
    setError(null);
    startDaemon()
      .then(() => awaitLive())
      .then(async () => {
        await client.invalidateQueries();
        onStarted();
      })
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not start metro.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Row justify="center" align="center" flex={1} padding={24}>
      <Col gap={16} align="center" width="100%" maxWidth={NOTICE_WIDTH}>
        <Text role="secondary">
          metro is stopped on {daemonHost(daemonBase())}. metro serve is still holding the address, so it can start from here.
        </Text>
        <Button
          dark={dark}
          label={busy ? 'Starting…' : 'Start metro'}
          loading={busy}
          disabled={busy}
          onPress={start}
          style={CENTER_SELF}
        />
        {error !== null ? (
          <Text size="sm" role="danger">
            {error}
          </Text>
        ) : null}
        <Text size="sm" role="secondary">
          <a className="hint-link" href="#/">
            All servers
          </a>
        </Text>
      </Col>
    </Row>
  );
}
