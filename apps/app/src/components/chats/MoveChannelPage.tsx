import { type ReactNode } from 'react';
import { findAccount, type FlatAccount } from '@metro-labs/client/api/accounts';
import { stationLabel } from '@metro-labs/client/api/attach';
import type { StationsView } from '@metro-labs/client/api/client';
import { CONNECTOR_EVENTS_SINCE } from '@metro-labs/client/api/connector-events';
import { channelMailbox, eventsKnown, isMailStation, MAIL_EVENT, type MailStation } from '@metro-labs/client/api/mail-move';
import type { OrgConnector } from '@metro-labs/client/api/org-connectors';
import { olderThan } from '@metro-labs/client/api/version';
import { currentServer } from '@metro-labs/client/auth/daemon';
import type { Selection } from '@metro-labs/client/selection';
import { useAgentBox } from '../connectors/ConnectorEvents.js';
import { ErrorState } from '../ui/ErrorState.js';
import { FocusFrame } from '../ui/FocusFrame.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { StateBlock } from '../ui/StateBlock.js';
import { DoneStep } from './move/DoneStep.js';
import { ReviewStep } from './move/ReviewStep.js';
import { SignInStep } from './move/SignInStep.js';
import { SwitchStep } from './move/SwitchStep.js';
import { useApply, useSignIn, type Apply, type MoveIds, type SignIn } from './move/use-move-actions.js';
import { useAgentName } from '../../lib/agent-hooks.js';
import { MOVE_STEPS, MOVE_TITLE, NOT_OPEN, stepperOf, updateFirst } from '../../lib/mail-move.js';
import { go } from '../../lib/nav.js';
import { useConnectorScope, useOrgConnectorsQuery } from '../../lib/org-connector-queries.js';
import { queryError, useStationsQuery } from '../../lib/queries.js';
import { useMailMove, type MailMove } from '../../lib/use-mail-move.js';

interface PageProps {
  project: string;
  accountId: string;
}

interface Channel {
  found: FlatAccount;
  station: MailStation;
  mailbox: string;
  ids: MoveIds;
}

interface FlowProps {
  project: string;
  channel: Channel;
  view: StationsView;
  connectors: readonly OrgConnector[];
  listedAt: number;
  agent: string;
  onClose: () => void;
}

interface StepProps extends Omit<FlowProps, 'view' | 'connectors' | 'listedAt'> {
  move: MailMove;
  signIn: SignIn;
  apply: Apply;
}

function Step({ project, channel, agent, onClose, move, signIn, apply }: StepProps): ReactNode {
  const { step, target } = move;
  const { station, mailbox, ids, found } = channel;
  const label = stationLabel(station);
  if (step.step === 'connector') return <SignInStep move={move} need={step} signIn={signIn} station={station} label={label} mailbox={mailbox} onClose={onClose} />;
  if (step.step === 'review') {
    const offered = (target?.connector.events ?? []).some((event) => event.name === MAIL_EVENT);
    return <ReviewStep move={move} apply={apply} station={station} agent={agent} receiving={found.row.enabled} readOnlyAtGoogle={station === 'gmail' && found.row.sendEnabled === false} offered={offered} onClose={onClose} />;
  }
  if (step.step !== 'done') return <SwitchStep move={move} ids={ids} agent={agent} signIn={signIn} automatic={apply.applied} />;
  const after: Selection = target === null ? { kind: 'chats', project } : { kind: 'tools', project, connector: target.connector.id };
  return <DoneStep move={move} ids={ids} project={project} agent={agent} label={label} managedGmail={station === 'gmail' && found.row.managed === true} mail={step.mail} onLeave={() => { go(after); }} />;
}

function Flow(props: FlowProps): ReactNode {
  const { channel, view, connectors, listedAt, agent, onClose } = props;
  const move = useMailMove({ station: channel.station, mailbox: channel.mailbox, found: channel.found, view, connectors, listedAt, serverId: channel.ids.serverId, agent });
  const signIn = useSignIn(move, channel.ids);
  const apply = useApply(move, channel.ids);
  if (move.step.step === 'connector' && move.step.need === 'checking') return <Waiting onClose={onClose} />;
  return (
    <FocusFrame title={MOVE_TITLE} onClose={onClose} steps={MOVE_STEPS} step={stepperOf(move.step)}>
      <Step project={props.project} channel={channel} agent={agent} onClose={onClose} move={move} signIn={signIn} apply={apply} />
    </FocusFrame>
  );
}

function Waiting({ onClose }: { onClose: () => void }): ReactNode {
  return (
    <FocusFrame title={MOVE_TITLE} onClose={onClose}>
      <RowsSkeleton rows={4} leading={false} />
    </FocusFrame>
  );
}

interface Refusal {
  title: string;
  text: string;
  action?: { label: string; onPress: () => void };
}

function Blocked({ refusal, onClose }: { refusal: Refusal; onClose: () => void }): ReactNode {
  return (
    <FocusFrame title={MOVE_TITLE} onClose={onClose}>
      <StateBlock icon="plug" title={refusal.title} text={refusal.text} action={refusal.action ?? { label: 'Back to the channel', onPress: onClose }} />
    </FocusFrame>
  );
}

interface Ready {
  view: StationsView;
  connectors: readonly OrgConnector[];
  listedAt: number;
  admin: boolean;
  version: string | null;
}

type Loaded = { ready: Ready } | { ready: null; failed: { error: unknown; refetch: () => Promise<unknown> } | null };

function useLoaded(): Loaded {
  const stations = useStationsQuery();
  const list = useOrgConnectorsQuery();
  const box = useAgentBox(currentServer()?.host ?? null, false);
  if (stations.data === undefined) return { ready: null, failed: stations.error === null ? null : stations };
  if (list.data === undefined) return { ready: null, failed: list.error === null ? null : list };
  if (box === null) return { ready: null, failed: null };
  return { ready: { view: stations.data, connectors: list.data.connectors, listedAt: Math.max(list.dataUpdatedAt, list.errorUpdatedAt), admin: list.data.admin, version: box.version } };
}

function channelOf(ready: Ready, accountId: string): Channel | Refusal {
  const found = findAccount(ready.view.groups, accountId);
  const serverId = currentServer()?.id;
  const boxAgentId = ready.view.agent?.id;
  if (found === undefined || serverId === undefined || boxAgentId === undefined) return { title: 'This channel is gone', text: 'It is not connected to the agent anymore.' };
  const { station } = found;
  if (!isMailStation(station)) return { title: 'This channel stays a channel', text: 'Only Gmail and Outlook channels move to a connector.' };
  const mailbox = channelMailbox(found.row);
  if (mailbox === null) return { title: 'The mailbox is not known right now', text: 'The channel does not answer, so Metro cannot read its address. Try again when it responds.' };
  return { found, station, mailbox, ids: { station, accountId, boxAgentId, serverId, mailbox } };
}

function refusalOf(ready: Ready, agent: string, project: string): Refusal | null {
  if (!ready.admin) return { title: 'Only an admin can move a channel', text: 'Ask an admin of the organization to move it.' };
  if (eventsKnown(ready.connectors) === false) return { title: 'Not open yet', text: NOT_OPEN };
  if (!olderThan(ready.version, CONNECTOR_EVENTS_SINCE)) return null;
  return { title: 'Update first', text: updateFirst(agent), action: { label: 'Open Server', onPress: () => { go({ kind: 'server', project }); } } };
}

function Body({ project, accountId }: PageProps): ReactNode {
  const agent = useAgentName();
  const loaded = useLoaded();
  const onClose = (): void => { go({ kind: 'station', project, accountId }); };
  if (loaded.ready === null) {
    const { failed } = loaded;
    if (failed === null) return <Waiting onClose={onClose} />;
    return (
      <FocusFrame title={MOVE_TITLE} onClose={onClose}>
        <ErrorState title="Could not load this channel" text={queryError(failed.error, 'Metro did not answer.')} onRetry={failed.refetch} />
      </FocusFrame>
    );
  }
  const channel = channelOf(loaded.ready, accountId);
  if ('title' in channel) return <Blocked refusal={channel} onClose={onClose} />;
  const refusal = refusalOf(loaded.ready, agent, project);
  if (refusal !== null) return <Blocked refusal={refusal} onClose={onClose} />;
  return <Flow project={project} channel={channel} view={loaded.ready.view} connectors={loaded.ready.connectors} listedAt={loaded.ready.listedAt} agent={agent} onClose={onClose} />;
}

export function MoveChannelPage(props: PageProps): ReactNode {
  const scope = useConnectorScope();
  return <Body key={`${String(scope)}:${props.accountId}`} {...props} />;
}
