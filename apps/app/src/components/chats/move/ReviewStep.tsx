import { type ReactNode } from 'react';
import type { MailStation } from '@metro-labs/client/api/mail-move';
import { Actions } from '../../ui/Actions.js';
import { FocusIntro } from '../../ui/FocusFrame.js';
import { notCarried, receiveLine, ruleLines, sendersLines } from '../../../lib/mail-move.js';
import type { MailMove } from '../../../lib/use-mail-move.js';
import { MoveSteps, SummaryGroup } from './MoveSteps.js';
import { useToggle, type Apply } from './use-move-actions.js';

interface ReviewProps {
  move: MailMove;
  apply: Apply;
  station: MailStation;
  agent: string;
  receiving: boolean;
  readOnlyAtGoogle: boolean;
  offered: boolean;
  onClose: () => void;
}

const notOffered = (connector: string): string => `${connector} does not offer new mail as an event yet, so receiving cannot move. Nothing was changed. Check again in a minute.`;

export function ReviewStep({ move, apply, station, agent, receiving, readOnlyAtGoogle, offered, onClose }: ReviewProps): ReactNode {
  const connector = move.target?.connector.name ?? '';
  const recheck = useToggle(move.recheck, 'Could not read the connector.');
  const missing = move.plan.receive && !offered;
  const busy = apply.running !== null;
  return (
    <>
      <FocusIntro title="Check what moves" text={`These settings of the channel are set for ${agent} on ${connector}. Each one can be changed later on the connector's page.`} />
      <SummaryGroup label="Who can write" lines={[...sendersLines(move.plan.senders), receiveLine(move.plan, receiving, agent)]} />
      <SummaryGroup label={`What ${agent} may do`} lines={ruleLines(move.plan.rules, agent)} />
      <SummaryGroup label="Not carried over" lines={notCarried(station, readOnlyAtGoogle)} />
      <MoveSteps actions={move.actions} running={apply.running} />
      <Actions
        error={missing ? notOffered(connector) : (apply.error ?? recheck.error)}
        note={move.plan.receive ? 'The old channel keeps receiving until mail arrives through the connector.' : undefined}
        cancel={{ onPress: onClose, disabled: busy }}
        main={missing ? { label: 'Check again', busy: recheck.busy, onPress: recheck.run } : { label: 'Move the channel', busy, onPress: apply.run }}
      />
    </>
  );
}
