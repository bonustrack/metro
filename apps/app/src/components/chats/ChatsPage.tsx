import { type ReactNode } from 'react';
import { Button } from '@stage-labs/kit/react-native/button';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { flattenAccounts, type FlatAccount } from '@metro-labs/client/api/accounts';
import { Icon } from '../Icon.js';
import { Group, Groups } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { ErrorState } from '../ui/ErrorState.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { StateBlock } from '../ui/StateBlock.js';
import { ChannelRow } from './ChannelRow.js';
import { RecentConversations } from './RecentConversations.js';
import { useReceive } from './use-receive.js';
import { VoiceRow } from './VoiceRow.js';
import { go } from '../../lib/nav.js';
import { queryError, useStationsQuery } from '../../lib/queries.js';
import { useDocumentTitle } from '../../lib/title.js';
import { ICON_SIZE } from '../ui/sizes.js';

const RECEIVE_NOTE = 'Off stops new messages. Tools keep working.';
const PLUS = ICON_SIZE.sm;

function AddChat({ onPress }: { onPress: () => void }): ReactNode {
  const palette = useKitPalette();
  return <Button size="sm" color="secondary" label="Add a chat" icon={<Icon name="plus" size={PLUS} color={palette.link} />} onPress={onPress} />;
}

interface ChannelsProps {
  project: string;
  agentId: string;
  accounts: FlatAccount[];
  onAdd: () => void;
}

function Channels({ project, agentId, accounts, onAdd }: ChannelsProps): ReactNode {
  const receive = useReceive(agentId);
  if (accounts.length === 0)
    return (
      <Group label="Channels" action={<AddChat onPress={onAdd} />}>
        <Item title="No chat yet" subtitle="Add one, so people can write to the agent." onPress={onAdd} chevron={false} />
      </Group>
    );
  return (
    <Group label="Channels" action={<AddChat onPress={onAdd} />} note={RECEIVE_NOTE} error={receive.error}>
      {accounts.map((item) => {
        const id = item.row.id ?? '';
        return (
          <ChannelRow
            key={`${item.station}/${id}`}
            item={item}
            project={project}
            receiving={receive.receiving(item.station, id, item.row.enabled)}
            busy={receive.busy(item.station, id)}
            onToggle={(next) => {
              receive.toggle(item.station, id, next);
            }}
          />
        );
      })}
    </Group>
  );
}

export function ChatsPage({ project }: { project: string }): ReactNode {
  const { data, error, refetch } = useStationsQuery();
  useDocumentTitle('Channels');
  if (data === undefined)
    return (
      <Group label="Channels">
        {error === null ? <RowsSkeleton rows={3} /> : <ErrorState title="Could not load the channels" text={queryError(error, 'The agent did not answer.')} onRetry={refetch} />}
      </Group>
    );
  const agent = data.agent;
  if (agent === undefined) return <StateBlock spinner title="Getting ready" text="The agent shows here within seconds." />;
  const accounts = flattenAccounts(data.groups);
  return (
    <Groups>
      <Channels project={project} agentId={agent.id} accounts={accounts} onAdd={() => { go({ kind: 'add-chat', project }); }} />
      <VoiceRow project={project} agentId={agent.id} accounts={accounts} />
      <RecentConversations project={project} />
    </Groups>
  );
}
