import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';
import { ConfirmModal } from './ConfirmModal';
import { awaitRestart, awaitStopped, restartDaemon, stopDaemon } from '../api/control';
import { queryError } from '../api/queries';

type Phase = 'idle' | 'restarting' | 'restarted' | 'stopping';

const STOP_LINES = [
  'Channels and connectors go offline until metro starts again.',
  'metro serve keeps holding the address, so Start works from this page and from the server list.',
];

export function DaemonControls(): ReactNode {
  const client = useQueryClient();
  const dark = useKitScheme() === 'dark';
  const [phase, setPhase] = useState<Phase>('idle');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = phase === 'restarting' || phase === 'stopping';

  const restart = (): void => {
    setPhase('restarting');
    setError(null);
    restartDaemon()
      .then(() => awaitRestart())
      .then(async () => {
        setPhase('restarted');
        await client.invalidateQueries();
      })
      .catch((err: unknown) => {
        setPhase('idle');
        setError(queryError(err, 'Could not restart metro.'));
      });
  };

  const stop = (): void => {
    setPhase('stopping');
    setError(null);
    stopDaemon()
      .then(() => awaitStopped())
      .then(async () => {
        setConfirming(false);
        await client.invalidateQueries();
      })
      .catch((err: unknown) => {
        setPhase('idle');
        setError(queryError(err, 'Could not stop metro.'));
      });
  };

  return (
    <Row gap={10} align="center" wrap>
      <Button
        size="sm"
        color="secondary"
        dark={dark}
        label={phase === 'restarting' ? 'Restarting…' : 'Restart'}
        disabled={busy}
        onPress={restart}
      />
      <Button
        size="sm"
        color="secondary"
        dark={dark}
        label="Stop"
        disabled={busy}
        onPress={() => {
          setError(null);
          setConfirming(true);
        }}
      />
      {phase === 'restarting' ? (
        <Text size="sm" role="secondary">
          The daemon is coming back…
        </Text>
      ) : null}
      {phase === 'restarted' ? (
        <Text size="sm" role="secondary">
          Restarted.
        </Text>
      ) : null}
      {error !== null && !confirming ? (
        <Text size="sm" role="danger">
          {error}
        </Text>
      ) : null}
      <ConfirmModal
        open={confirming}
        title="Stop metro on this machine"
        lines={STOP_LINES}
        prompt="Type stop to confirm."
        confirmWord="stop"
        confirmLabel="Stop metro"
        busy={phase === 'stopping'}
        error={confirming ? error : null}
        onClose={() => {
          if (phase !== 'stopping') setConfirming(false);
        }}
        onConfirm={stop}
      />
    </Row>
  );
}
