import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { ConfirmModal } from './ConfirmModal.js';
import { SettingsSection } from './SettingsSection.js';
import { awaitRestart, awaitStopped, restartDaemon, stopDaemon } from '../api/control.js';
import { queryError } from '../api/queries.js';

type Phase = 'idle' | 'restarting' | 'restarted' | 'stopping';

const STOP_LINES = [
  'Your agent stops answering on every channel until Metro starts again.',
  'You can start it again from this page or from the agent list.',
];
const RESTART_NOTE = 'Turns Metro off and on again. Takes a few seconds.';
const STOP_NOTE = 'Your agent stops answering until you start it again.';
const PHASE_TEXT: Partial<Record<Phase, string>> = {
  restarting: 'Coming back…',
  restarted: 'Restarted.',
};

export function DaemonControls(): ReactNode {
  const client = useQueryClient();
  const dark = useKitScheme() === 'dark';
  const [phase, setPhase] = useState<Phase>('idle');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = phase === 'restarting' || phase === 'stopping';
  const note = PHASE_TEXT[phase];

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
    <>
      <SettingsSection title="Restart" note={note ?? RESTART_NOTE}>
        <Button
          size="sm"
          color="secondary"
          dark={dark}
          label={phase === 'restarting' ? 'Restarting…' : 'Restart'}
          disabled={busy}
          onPress={restart}
        />
        {error !== null && !confirming ? (
          <Text size="sm" role="danger">
            {error}
          </Text>
        ) : null}
      </SettingsSection>
      <SettingsSection title="Stop" note={STOP_NOTE}>
        <Button
          size="sm"
          color="danger"
          dark={dark}
          label="Stop"
          disabled={busy}
          onPress={() => {
            setError(null);
            setConfirming(true);
          }}
        />
      </SettingsSection>
      <ConfirmModal
        open={confirming}
        title="Stop Metro"
        lines={STOP_LINES}
        confirmWord="stop"
        confirmLabel="Stop Metro"
        busy={phase === 'stopping'}
        error={confirming ? error : null}
        onClose={() => {
          if (phase !== 'stopping') setConfirming(false);
        }}
        onConfirm={stop}
      />
    </>
  );
}
