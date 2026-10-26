import { type ReactNode, useState } from 'react';
import { CheckBox } from '@stage-labs/kit/react-native/check-box';
import { useQueryClient } from '@tanstack/react-query';
import { findAccount, stationFields, type FlatAccount } from '@metro-labs/client/api/accounts';
import { detachAccount, stationLabel } from '@metro-labs/client/api/attach';
import { DeleteMenu } from '../DeleteMenu.js';
import { detachLines } from './detach-lines.js';
import { StationIcon } from '../StationIcon.js';
import { AgentDeepPage } from '../agent/AgentDeepPage.js';
import { Item } from '../ui/Item.js';
import { ErrorState } from '../ui/ErrorState.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { StateBlock } from '../ui/StateBlock.js';
import { type ChannelProps } from './channel-props.js';
import { ChannelPeople } from './ChannelPeople.js';
import { ChannelConnection } from './ChannelConnection.js';
import { ChannelSummary } from './ChannelSummary.js';
import { PairAgain } from './PairAgain.js';
import { ChannelRules } from './ChannelRules.js';
import { channelTitle } from './ChannelRow.js';
import { ChannelDetails, ChannelSetup } from './ChannelSetup.js';
import { ExceptionsPage } from './ExceptionsPage.js';
import { GmailAccess } from './GmailAccess.js';
import { Group } from '../ui/Group.js';
import { useReceive } from './use-receive.js';
import { channelLine } from '../../lib/channel-people.js';
import { ruleTarget, targetTool } from '../../lib/channel-rules.js';
import { go } from '../../lib/nav.js';
import { openExternal } from '../../lib/open.js';
import { dropAccount, queryError, refresh, useStationsQuery } from '../../lib/queries.js';
import { useDocumentTitle } from '../../lib/title.js';
import { AVATAR_SIZE } from '../ui/sizes.js';

const RECEIVE_NOTE = 'Off stops new messages. Tools keep working.';

function ChannelMenu({ project, agentId, found, onPairAgain }: Pick<ChannelProps, 'project' | 'agentId' | 'found'> & { onPairAgain: (() => void) | null }): ReactNode {
  const client = useQueryClient();
  const { station, row } = found;
  const url = stationFields(row).url;
  const id = row.id;
  if (id === null) return null;
  const open = url === undefined ? [] : [{ label: `Open in ${stationLabel(station)}`, icon: 'chat' as const, onSelect: () => { openExternal(url); } }];
  const pair = onPairAgain === null ? [] : [{ label: 'Pair again', icon: 'refresh' as const, onSelect: onPairAgain }];
  return (
    <DeleteMenu
      label="Channel actions"
      items={[...open, ...pair]}
      action="Delete channel"
      title="Delete channel"
      lines={detachLines(station, row.managed === true)}
      word={id}
      failure="Could not delete the channel."
      run={async () => {
        await detachAccount(agentId, station, id);
        dropAccount(client, station, id);
        await refresh(client, 'stations');
      }}
      onDone={() => { go({ kind: 'chats', project }); }}
    />
  );
}

function Receive({ agentId, found }: { agentId: string; found: FlatAccount }): ReactNode {
  const receive = useReceive(agentId);
  const { station, row } = found;
  const id = row.id;
  if (id === null) return null;
  return (
    <Group error={receive.error}>
      <Item
        title="Receive messages"
        subtitle={RECEIVE_NOTE}
        trailing={<CheckBox displayStyle="switch" value={receive.receiving(station, id, row.enabled)} disabled={receive.busy(station, id)} name="Receive messages" onChange={(next) => { receive.toggle(station, id, next); }} />}
      />
    </Group>
  );
}

function ChannelDetail({ project, agentId, found, view, onSaved }: ChannelProps): ReactNode {
  const [pairing, setPairing] = useState<'fix' | 'replace' | null>(null);
  const { station, row } = found;
  const title = channelTitle(found);
  const id = row.id;
  const canPair = id !== null && view.pairAgain.includes(station);
  return (
    <AgentDeepPage
      project={project}
      tab="chats"
      trail={[{ label: stationLabel(station) }]}
      title={title}
      subtitle={channelLine(stationLabel(station), row.allowlist)}
      leading={<StationIcon station={station} size={AVATAR_SIZE.header} />}
      action={<ChannelMenu project={project} agentId={agentId} found={found} onPairAgain={canPair ? () => { setPairing(row.status?.state === 'logged_out' ? 'fix' : 'replace'); } : null} />}
      summary={<ChannelSummary agentId={agentId} found={found} view={view} />}
    >
      <ChannelConnection found={found} view={view} onPairAgain={() => { setPairing('fix'); }} />
      {pairing === null || id === null ? null : (
        <PairAgain agentId={agentId} station={station} accountId={id} handle={stationFields(row).handle} replaces={pairing === 'replace'} onSaved={onSaved} onClose={() => { setPairing(null); }} />
      )}
      <Receive agentId={agentId} found={found} />
      {id === null || row.allowlist === null ? null : (
        <ChannelPeople agentId={agentId} station={station} accountId={id} handle={stationFields(row).handle ?? ''} allowlist={row.allowlist} approvers={row.approvers} onSaved={onSaved} />
      )}
      {station === 'gmail' ? <GmailAccess key={`${agentId}/${id ?? ''}`} agentId={agentId} row={row} features={view.features} onSaved={onSaved} /> : null}
      <ChannelRules project={project} agentId={agentId} found={found} view={view} onSaved={onSaved} />
      <ChannelSetup station={station} row={row} agentId={agentId} />
      <ChannelDetails station={station} row={row} />
    </AgentDeepPage>
  );
}

function Gone({ project }: { project: string }): ReactNode {
  return (
    <AgentDeepPage project={project} tab="chats" trail={[{ label: 'Channel' }]}>
      <StateBlock icon="exclamationCircle" title="This channel is gone" text="It is not connected to the agent anymore." action={{ label: 'Back to Channels', onPress: () => { go({ kind: 'chats', project }); } }} />
    </AgentDeepPage>
  );
}

export function ChannelPage({ project, accountId, rule }: { project: string; accountId: string; rule: string | undefined }): ReactNode {
  const client = useQueryClient();
  const { data, error, refetch } = useStationsQuery();
  const found = data === undefined ? undefined : findAccount(data.groups, accountId);
  useDocumentTitle(found === undefined ? 'Channel' : channelTitle(found));
  if (data === undefined)
    return (
      <AgentDeepPage project={project} tab="chats" trail={[{ label: 'Channel' }]}>
        {error === null ? <RowsSkeleton rows={4} /> : <ErrorState title="Could not load this channel" text={queryError(error, 'The agent did not answer.')} onRetry={refetch} />}
      </AgentDeepPage>
    );
  const agentId = data.agent?.id;
  if (found === undefined || agentId === undefined) return <Gone project={project} />;
  return <ChannelView props={{ project, agentId, found, view: data, onSaved: () => refresh(client, 'stations') }} rule={rule} />;
}

function ChannelView({ props, rule }: { props: ChannelProps; rule: string | undefined }): ReactNode {
  const target = rule === undefined ? null : ruleTarget(rule);
  if (rule === 'exceptions' || (target !== null && targetTool(target) !== null)) return <ExceptionsPage {...props} />;
  return <ChannelDetail {...props} />;
}
