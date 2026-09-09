import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { useQueryClient } from '@tanstack/react-query';
import { Text, Button } from './ui.js';
import { SHRINK } from '../theme.js';
import { PageTitle } from './PageTitle.js';
import { AccountList } from './AccountList.js';
import { ConnectStation } from './ConnectStation.js';
import { CountBadge } from './CountBadge.js';
import { Loading } from './Loading.js';
import { accountsForAgent } from '../api/accounts.js';
import { detachAccount } from '../api/attach.js';
import { dropAccount, queryError, refreshAgents, useStationsQuery } from '../api/queries.js';
import { useDocumentTitle } from '../title.js';

const FALLBACK = 'Could not load the channels.';

interface StationsProps {
  project: string;
  onOpen: (accountId: string) => void;
}

export function Stations({ project, onOpen }: StationsProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const client = useQueryClient();
  const { data, error } = useStationsQuery();
  const [connecting, setConnecting] = useState(false);
  useDocumentTitle('Channels');
  if (error !== null) return <Text size="sm" role="danger">{queryError(error, FALLBACK)}</Text>;
  if (data === undefined) return <Loading />;
  const agent = data.agents[0];
  if (agent === undefined) return <Text size="sm" role="secondary">Create the agent first, from the first page.</Text>;
  const mine = accountsForAgent(data.groups, agent.id);
  return (
    <Col gap={16}>
      <Row justify="between" align="start" gap={12} wrap>
        <Col gap={8} style={SHRINK}>
          <Row gap={10} align="center">
            <PageTitle>Channels</PageTitle>
            <CountBadge count={mine.reduce((n, g) => n + g.rows.length, 0)} beside="title" />
          </Row>
        </Col>
        <Button
          color="primary"
          dark={dark}
          label="Connect channel"
          onPress={() => {
            setConnecting(true);
          }}
        />
      </Row>
      <AccountList
        groups={mine}
        project={project}
        empty="No channel yet. Connect one with the button above."
        onOpen={onOpen}
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
