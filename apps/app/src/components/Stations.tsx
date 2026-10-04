import { type ReactNode, useState } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { ListHeader } from './ListHeader.js';
import { AccountList } from './AccountList.js';
import { ConnectStation } from './ConnectStation.js';
import { Loading } from './Loading.js';
import { detachAccount } from '@metro-labs/client/api/attach';
import { dropAccount, queryError, refreshAgents, useStationsQuery } from '../lib/queries.js';
import { useDocumentTitle } from '../lib/title.js';

const FALLBACK = 'Could not load the channels.';

export function Stations({ project }: { project: string }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const client = useQueryClient();
  const { data, error } = useStationsQuery();
  const [connecting, setConnecting] = useState(false);
  useDocumentTitle('Channels');
  if (error !== null) return <Text size="2xs" role="danger">{queryError(error, FALLBACK)}</Text>;
  if (data === undefined) return <Loading />;
  const agent = data.agent;
  if (agent === undefined) return <Text size="2xs" role="secondary">Create the agent first, from the first page.</Text>;
  const mine = data.groups;
  return (
    <Col gap={16}>
      <ListHeader
        title="Channels"
        count={mine.reduce((n, g) => n + g.rows.length, 0)}
        action={
          <Button
            color="primary"
            dark={dark}
            label="Connect channel"
            onPress={() => {
              setConnecting(true);
            }}
          />
        }
      />
      <AccountList
        groups={mine}
        project={project}
        empty="No channel yet. Connect one with the button above."
        onDetach={async (station, accountId) => {
          await detachAccount(agent.id, station, accountId);
          dropAccount(client, station, accountId);
          refreshAgents(client);
        }}
      />
      <ConnectStation
        agentId={agent.id}
        attachable={data.attachable}
        open={connecting}
        onClose={() => {
          setConnecting(false);
        }}
        onChanged={() => {
          refreshAgents(client);
        }}
      />
    </Col>
  );
}
