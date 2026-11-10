import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { MoveStep } from '@metro-labs/client/api/mail-move';
import { Actions } from '../../ui/Actions.js';
import { FocusIntro } from '../../ui/FocusFrame.js';
import { overlapNote, overlapSeconds, statusWords } from '../../../lib/mail-move.js';
import type { MailMove } from '../../../lib/use-mail-move.js';
import { useNow } from '../../../lib/use-now.js';
import { MailStatus, MoveSteps } from './MoveSteps.js';
import { channelSwitch, eventOff, useToggle, type MoveIds, type SignIn } from './use-move-actions.js';

interface SwitchProps {
  move: MailMove;
  ids: MoveIds;
  agent: string;
  signIn: SignIn;
  automatic: boolean;
}

const TWICE = 'Could not switch Receive messages off on the old channel. Mail arrives twice until it is off.';

function Status({ move, ids, agent, note }: Pick<SwitchProps, 'move' | 'ids' | 'agent'> & { note?: string }): ReactNode {
  return <MailStatus words={statusWords(move.step, { agent, mailbox: ids.mailbox })} note={note} />;
}

function Starting({ move, ids, agent, signIn, state }: SwitchProps & { state: Extract<MoveStep, { step: 'starting' }>['state'] }): ReactNode {
  const stop = useToggle(eventOff(move, ids), 'Could not turn Email received off.');
  return (
    <>
      <FocusIntro title="Switching mail over" text="Email received is on. Metro waits until mail arrives through the connector before it touches the old channel." />
      <Status move={move} ids={ids} agent={agent} />
      <MoveSteps actions={move.actions} running={null} />
      <Actions
        error={stop.error ?? signIn.error}
        note="To stop here, turn Email received off. The old channel stays as it is."
        cancel={{ label: 'Turn Email received off', onPress: stop.run, disabled: stop.busy }}
        main={state === 'signin' ? { label: 'Sign in again', busy: signIn.busy, onPress: signIn.start } : undefined}
      />
    </>
  );
}

function Overlap({ move, ids, agent, automatic }: SwitchProps): ReactNode {
  const [since] = useState(Date.now);
  const seconds = overlapSeconds(since, useNow());
  const off = useToggle(channelSwitch(ids, false), TWICE);
  const fired = useRef(false);
  const { run } = off;
  useEffect(() => {
    if (!automatic || seconds > 0 || fired.current) return;
    fired.current = true;
    run();
  }, [automatic, seconds, run]);
  const byItself = automatic && off.error === null;
  return (
    <>
      <FocusIntro title="Switching mail over" text="Mail arrives through the connector. The old channel is switched off next, once it has delivered what arrived before." />
      <Status move={move} ids={ids} agent={agent} note={overlapNote(seconds, byItself)} />
      <MoveSteps actions={move.actions} running={byItself || off.busy ? 'channel' : null} />
      {byItself ? null : <Actions error={off.error} main={{ label: off.error === null ? 'Switch the old channel off' : 'Try again', busy: off.busy, disabled: seconds > 0, onPress: off.run }} />}
    </>
  );
}

export function SwitchStep(props: SwitchProps): ReactNode {
  const { step } = props.move;
  if (step.step === 'starting') return <Starting {...props} state={step.state} />;
  return step.step === 'overlap' ? <Overlap {...props} /> : null;
}
