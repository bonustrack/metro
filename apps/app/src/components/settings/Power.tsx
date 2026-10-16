import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { awaitRestart, awaitStopped, restartDaemon, stopDaemon } from '@metro-labs/client/api/control';
import { Item } from '../ui/Item.js';
import { AskDialog } from './AskDialog.js';
import { queryError } from '../../lib/queries.js';

type Phase = 'idle' | 'restarting' | 'restarted' | 'stopping';
type Asking = 'restart' | 'stop' | null;

export interface Power {
  phase: Phase;
  asking: Asking;
  error: string | null;
  ask: (what: Exclude<Asking, null>) => void;
  close: () => void;
  restart: () => void;
  stop: () => void;
}

const RESTART_NOTE = 'Back in about a minute';
const STOP_NOTE = 'Off until you start it';
const PHASE_NOTE: Partial<Record<Phase, string>> = { restarting: 'Coming back…', restarted: 'Restarted', stopping: 'Stopping…' };

export function usePower(): Power {
  const client = useQueryClient();
  const [phase, setPhase] = useState<Phase>('idle');
  const [asking, setAsking] = useState<Asking>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = phase === 'restarting' || phase === 'stopping';
  const fail = (fallback: string) => (err: unknown): void => {
    setPhase('idle');
    setError(queryError(err, fallback));
  };
  const restart = (): void => {
    setPhase('restarting');
    setError(null);
    restartDaemon()
      .then(() => awaitRestart())
      .then(async () => {
        setAsking(null);
        setPhase('restarted');
        await client.invalidateQueries();
      })
      .catch(fail('Could not restart Metro.'));
  };
  const stop = (): void => {
    setPhase('stopping');
    setError(null);
    stopDaemon()
      .then(() => awaitStopped())
      .then(async () => {
        setAsking(null);
        setPhase('idle');
        await client.invalidateQueries();
      })
      .catch(fail('Could not stop Metro.'));
  };
  return {
    phase,
    asking,
    error,
    ask: (what) => {
      if (busy) return;
      setError(null);
      setAsking(what);
    },
    close: () => {
      if (!busy) setAsking(null);
    },
    restart,
    stop,
  };
}

const RESTART_LINES = ['Metro turns off and on again, and your agent is back in about a minute.'];
const STOP_LINES = ['Your agent stops answering on every channel until you press Start on its page.'];

export function PowerDialogs({ power, name }: { power: Power; name: string }): ReactNode {
  return (
    <>
      <AskDialog
        open={power.asking === 'restart'}
        title={`Restart ${name}?`}
        lines={RESTART_LINES}
        action="Restart"
        busy={power.phase === 'restarting'}
        error={power.asking === 'restart' ? power.error : null}
        onClose={power.close}
        onConfirm={power.restart}
      />
      <AskDialog
        open={power.asking === 'stop'}
        title={`Stop ${name}?`}
        lines={STOP_LINES}
        action="Stop"
        busy={power.phase === 'stopping'}
        error={power.asking === 'stop' ? power.error : null}
        onClose={power.close}
        onConfirm={power.stop}
      />
    </>
  );
}

export function PowerRows({ name }: { name: string }): ReactNode {
  const power = usePower();
  const failed = power.error !== null && power.asking === null;
  return (
    <>
      <Item
        title="Restart"
        subtitle={failed ? (power.error ?? undefined) : (PHASE_NOTE[power.phase] ?? RESTART_NOTE)}
        subtitleTone={failed ? 'danger' : 'secondary'}
        onPress={() => {
          power.ask('restart');
        }}
      />
      <Item
        title="Stop"
        subtitle={power.phase === 'stopping' ? PHASE_NOTE.stopping : STOP_NOTE}
        onPress={() => {
          power.ask('stop');
        }}
      />
      <PowerDialogs power={power} name={name} />
    </>
  );
}
