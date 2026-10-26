import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Text } from '@stage-labs/kit/react-native/text';
import { awaitLive, startDaemon } from '@metro-labs/client/api/control';
import { serverLabel } from '@metro-labs/client/api/servers';
import { currentServer } from '@metro-labs/client/auth/daemon';
import { StateBlock } from './ui/StateBlock.js';
import { queryError, useServersQuery } from '../lib/queries.js';

function useName(): string {
  const servers = useServersQuery();
  const here = currentServer();
  const server = servers.data?.find((s) => s.id === here?.id);
  return server === undefined ? 'This agent' : serverLabel(server);
}

export function StoppedNotice({ onStarted }: { onStarted: () => void }): ReactNode {
  const client = useQueryClient();
  const name = useName();
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
        setError(queryError(err, 'Could not start Metro.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <StateBlock icon="pause" title={`${name} is stopped`} text="Metro is stopped on its server. It can start again from here."
      action={{ label: `Start ${name}`, primary: true, busy, onPress: start }}>
      {error === null ? null : <Text size="xs" color="danger">{error}</Text>}
    </StateBlock>
  );
}
