import { type ReactNode, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { offeredStations, STATION_FORMS, type AttachResult } from '@metro-labs/client/api/attach';
import { agentsUrl } from '@metro-labs/client/api/client';
import { GMAIL_MANAGED } from '@metro-labs/client/api/gmail';
import { routeHash } from '@metro-labs/client/route';
import { AttachedAccount } from './AttachedAccount.js';
import { AttachSession } from './AttachSession.js';
import { StationForm } from './StationForm.js';
import { StationPicker } from './StationPicker.js';
import { ErrorState } from './ui/ErrorState.js';
import { FocusFrame, FocusIntro, type FocusStep } from './ui/FocusFrame.js';
import { RowsSkeleton } from './ui/RowsSkeleton.js';
import { StateBlock } from './ui/StateBlock.js';
import { useAgentName } from '../lib/agent-hooks.js';
import { go } from '../lib/nav.js';
import { queryError, refreshAgents, useStationsQuery } from '../lib/queries.js';
import { useAttach } from '../lib/use-attach.js';

const TAIL = ['xmtp', 'webhook'];

const STEPS: FocusStep[] = [
  { id: 'pick', label: 'Channel' },
  { id: 'connect', label: 'Connect' },
  { id: 'done', label: 'Done' },
];

const rank = (station: string): number => TAIL.indexOf(station);

const inOneStep = (station: string): boolean => Platform.OS === 'web' && STATION_FORMS[station]?.provider !== undefined;

function orderStations(attachable: string[]): string[] {
  return offeredStations(attachable).sort((a, b) => rank(a) - rank(b));
}

interface FlowProps {
  project: string;
  agentId: string;
  attachable: string[];
  features: string[];
  station: string | null;
}

function Picker({ project, known }: { project: string; known: string[] }): ReactNode {
  const name = useAgentName();
  if (known.length === 0)
    return <StateBlock icon="chat" title="No channel to connect" text="This Metro offers no channel you can connect." action={{ label: 'Back to Channels', onPress: () => { go({ kind: 'chats', project }); } }} />;
  return (
    <>
      <FocusIntro title={`Where should ${name} be reachable?`} text="Pick a channel. Next, you sign in or paste its details." />
      <StationPicker stations={known} hrefOf={(station) => routeHash({ kind: 'add-chat', project, station })} />
    </>
  );
}

function AddChatFlow({ project, agentId, attachable, features, station }: FlowProps): ReactNode {
  const client = useQueryClient();
  const [result, setResult] = useState<AttachResult | null>(null);
  const attach = useAttach(agentId);
  const known = orderStations(attachable);
  const picked = station !== null && known.includes(station) ? station : null;
  const pending = attach.started?.kind === 'pending' ? attach.started.session : null;
  const close = (): void => {
    attach.close();
    go({ kind: 'chats', project });
  };
  const done = (next: AttachResult): void => {
    setResult(next);
    refreshAgents(client);
  };
  useEffect(() => {
    if (attach.started?.kind === 'done') done(attach.started.result);
  }, [attach.started]);
  const back = (): void => {
    attach.clearError();
    go({ kind: 'add-chat', project });
  };
  const step = result !== null ? 'done' : pending !== null || picked !== null ? 'connect' : 'pick';
  const body = (): ReactNode => {
    if (result !== null) return <AttachedAccount result={result} onDismiss={close} />;
    if (pending !== null) return <AttachSession agentId={agentId} base={attach.base} identity={attach.identity} session={pending} opened={attach.opened} onUpdate={attach.update} onDone={done} onClose={close} />;
    if (picked === null) return <Picker project={project} known={known} />;
    return <StationForm key={picked} station={picked} gmailManaged={features.includes(GMAIL_MANAGED)} busy={attach.busy} error={attach.error} onBack={back} onStart={(fields) => { if (inOneStep(picked)) attach.startInTab(picked, fields); else attach.start(picked, fields); }} />;
  };
  return (
    <FocusFrame title="Add channel" onClose={close} steps={STEPS} step={step} onStep={step === 'connect' && pending === null ? back : undefined}>
      {body()}
    </FocusFrame>
  );
}

export function AddChatPage({ project, station }: { project: string; station?: string }): ReactNode {
  const { data, error, refetch } = useStationsQuery();
  const close = (): void => {
    go({ kind: 'chats', project });
  };
  const agent = data?.agent;
  if (data === undefined || agent === undefined || error !== null)
    return (
      <FocusFrame title="Add channel" onClose={close} steps={STEPS} step="pick">
        {error !== null ? (
          <ErrorState title="Could not load the channels" text={queryError(error, 'The agent did not answer.')} onRetry={refetch} />
        ) : data === undefined ? (
          <RowsSkeleton rows={5} />
        ) : (
          <StateBlock spinner title="Getting ready" text="The agent shows here within seconds." />
        )}
      </FocusFrame>
    );
  return <AddChatFlow key={`${agentsUrl()}/${agent.id}`} project={project} agentId={agent.id} attachable={data.attachable} features={data.features} station={station ?? null} />;
}
