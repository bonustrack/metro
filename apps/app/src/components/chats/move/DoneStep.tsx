import { type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { detachAccount } from '@metro-labs/client/api/attach';
import { routeHash } from '@metro-labs/client/route';
import { ConfirmDialog, useConfirm } from '../../DeleteMenu.js';
import { TextLink } from '../../TextLink.js';
import { Actions } from '../../ui/Actions.js';
import { FocusIntro } from '../../ui/FocusFrame.js';
import { logError } from '../../../lib/log.js';
import { removeLines, statusWords } from '../../../lib/mail-move.js';
import { dropAccount, refresh } from '../../../lib/queries.js';
import type { MailMove } from '../../../lib/use-mail-move.js';
import { MailStatus, MoveSteps } from './MoveSteps.js';
import { channelSwitch, useToggle, type MoveIds } from './use-move-actions.js';

interface DoneProps {
  move: MailMove;
  ids: MoveIds;
  project: string;
  agent: string;
  label: string;
  managedGmail: boolean;
  mail: 'connector' | 'waiting' | 'none';
  onLeave: () => void;
}

const TITLE: Record<DoneProps['mail'], string> = { connector: 'The mailbox has moved', waiting: 'The connector is not sending', none: 'The settings have moved' };

function Fix({ move, project, agent, mail }: Pick<DoneProps, 'move' | 'project' | 'agent' | 'mail'>): ReactNode {
  const connector = move.target?.connector;
  if (connector === undefined || mail === 'connector') return null;
  const words = mail === 'none' ? `Open ${connector.name} for ${agent} to turn Email received on` : `Open ${connector.name} for ${agent} to see what it waits for`;
  return <TextLink to={routeHash({ kind: 'tools', project, connector: connector.id })}>{words}</TextLink>;
}

export function DoneStep({ move, ids, project, agent, label, managedGmail, mail, onLeave }: DoneProps): ReactNode {
  const client = useQueryClient();
  const words = statusWords(move.step, { agent, mailbox: ids.mailbox });
  const back = useToggle(channelSwitch(ids, true), 'Could not switch Receive messages back on.');
  const removing = useConfirm(async () => {
    await detachAccount(ids.boxAgentId, ids.station, ids.accountId);
    onLeave();
    dropAccount(client, ids.station, ids.accountId);
    refresh(client, 'stations').catch(logError('mail-move'));
  }, 'Could not delete the channel.');
  const waiting = mail === 'waiting';
  return (
    <>
      <FocusIntro title={TITLE[mail]} text={waiting ? undefined : `The old ${label} channel is switched off and still on the agent's server. Remove it now, or keep it switched off and remove it later from its page.`} />
      <MailStatus words={words} />
      <Fix move={move} project={project} agent={agent} mail={mail} />
      <MoveSteps actions={move.actions} running={null} />
      {waiting ? (
        <Actions error={back.error} note="Until the connector sends, the old channel can receive again." cancel={{ label: 'Close', onPress: onLeave, disabled: back.busy }} main={{ label: 'Switch the old channel back on', busy: back.busy, onPress: back.run }} />
      ) : (
        <Actions cancel={{ label: 'Keep it switched off', onPress: onLeave }} main={{ label: 'Remove the old channel', danger: true, onPress: removing.show }} />
      )}
      <ConfirmDialog confirming={removing} title="Remove the old channel" lines={removeLines(managedGmail, mail === 'connector')} action="Remove the channel" word={ids.accountId} />
    </>
  );
}
