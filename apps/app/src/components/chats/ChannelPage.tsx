import { type ReactNode } from 'react';
import { Switch } from '@stage-labs/kit/react-native/switch';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { useQueryClient } from '@tanstack/react-query';
import { findAccount, stationFields, type FlatAccount } from '@metro-labs/client/api/accounts';
import { detachAccount, stationLabel } from '@metro-labs/client/api/attach';
import { routeHash } from '@metro-labs/client/route';
import { DeleteMenu } from '../DeleteMenu.js';
import { detachLines } from './detach-lines.js';
import { Loading } from '../Loading.js';
import { StationIcon } from '../StationIcon.js';
import { Groups } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { PageHeader } from '../ui/PageHeader.js';
import { StateBlock } from '../ui/StateBlock.js';
import { type ChannelProps } from './channel-props.js';
import { ChannelPeople } from './ChannelPeople.js';
import { ChannelRules } from './ChannelRules.js';
import { channelTitle } from './ChannelRow.js';
import { ChannelDetails, ChannelSetup } from './ChannelSetup.js';
import { DeepNav } from './DeepNav.js';
import { ExceptionsPage } from './ExceptionsPage.js';
import { GmailAccess } from './GmailAccess.js';
import { RulePage } from './RulePage.js';
import { Section } from './Section.js';
import { useReceive } from './use-receive.js';
import { ruleTarget } from '../../lib/channel-rules.js';
import { go } from '../../lib/nav.js';
import { openExternal } from '../../lib/open.js';
import { dropAccount, queryError, refresh, useStationsQuery } from '../../lib/queries.js';
import { useDocumentTitle } from '../../lib/title.js';

const ICON = 28;
const RECEIVE_NOTE = 'Off stops new messages. Tools keep working.';

function ChannelMenu({ project, agentId, found }: Pick<ChannelProps, 'project' | 'agentId' | 'found'>): ReactNode {
  const client = useQueryClient();
  const { station, row } = found;
  const url = stationFields(row).url;
  const id = row.id;
  if (id === null) return null;
  return (
    <DeleteMenu
      label="Channel actions"
      items={url === undefined ? [] : [{ label: `Open in ${stationLabel(station)}`, icon: 'chat', onSelect: () => { openExternal(url); } }]}
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
  const dark = useKitScheme() === 'dark';
  const receive = useReceive(agentId);
  const { station, row } = found;
  const id = row.id;
  if (id === null) return null;
  return (
    <Section error={receive.error}>
      <Item
        title="Receive messages"
        subtitle={RECEIVE_NOTE}
        trailing={<Switch checked={receive.receiving(station, id, row.enabled)} disabled={receive.busy(station, id)} dark={dark} name="Receive messages" onChange={(next) => { receive.toggle(station, id, next); }} />}
      />
    </Section>
  );
}

function ChannelDetail({ project, agentId, found, view, onSaved }: ChannelProps): ReactNode {
  const { station, row } = found;
  const title = channelTitle(found);
  const id = row.id;
  return (
    <>
      <DeepNav project={project} trail={[{ label: stationLabel(station) }]} />
      <Groups>
        <PageHeader title={title} leading={<StationIcon station={station} size={ICON} />} action={<ChannelMenu project={project} agentId={agentId} found={found} />} />
        <Receive agentId={agentId} found={found} />
        {id === null || row.allowlist === null ? null : (
          <ChannelPeople agentId={agentId} station={station} accountId={id} handle={stationFields(row).handle ?? ''} allowlist={row.allowlist} approvers={row.approvers} onSaved={onSaved} />
        )}
        {station === 'gmail' ? <GmailAccess key={`${agentId}/${id ?? ''}`} agentId={agentId} row={row} features={view.features} onSaved={onSaved} /> : null}
        {id === null ? null : <ChannelRules project={project} accountId={id} policy={row.policy} tools={view.tools[station] ?? []} verbs={view.capabilities[station] ?? []} />}
        <ChannelSetup station={station} row={row} agentId={agentId} />
        <ChannelDetails station={station} row={row} />
      </Groups>
    </>
  );
}

function Gone({ project }: { project: string }): ReactNode {
  return (
    <>
      <DeepNav project={project} trail={[{ label: 'Channel' }]} />
      <StateBlock icon="exclamationCircle" title="This channel is gone" text="It is not connected to the agent anymore." action={{ label: 'Back to Chats', onPress: () => { go({ kind: 'chats', project }); } }} />
    </>
  );
}

export function ChannelPage({ project, accountId, rule }: { project: string; accountId: string; rule: string | undefined }): ReactNode {
  const client = useQueryClient();
  const { data, error } = useStationsQuery();
  const found = data === undefined ? undefined : findAccount(data.groups, accountId);
  useDocumentTitle(found === undefined ? 'Channel' : channelTitle(found));
  if (error !== null) return <StateBlock icon="exclamationCircle" danger title="Could not load this channel" text={queryError(error, 'The agent did not answer.')} />;
  if (data === undefined) return <Loading />;
  const agentId = data.agent?.id;
  if (found === undefined || agentId === undefined) return <Gone project={project} />;
  return <ChannelView props={{ project, agentId, found, view: data, onSaved: () => refresh(client, 'stations') }} rule={rule} />;
}

function ChannelView({ props, rule }: { props: ChannelProps; rule: string | undefined }): ReactNode {
  const target = rule === undefined ? null : ruleTarget(rule);
  if (rule === 'exceptions') return <ExceptionsPage {...props} />;
  if (target === null) return <ChannelDetail {...props} />;
  return <RulePage {...props} target={target} channelHref={routeHash({ kind: 'station', project: props.project, accountId: props.found.row.id ?? '' })} />;
}
