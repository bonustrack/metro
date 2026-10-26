import { type ReactNode } from 'react';
import { type BoxServer } from '@metro-labs/client/api/servers';
import { routeHash } from '@metro-labs/client/route';
import { Group } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { Fact } from './rows.js';
import { useClaudeSessionQuery, useClaudeSetupQuery, useMachineQuery } from '../../lib/queries.js';
import { exactTime, runnerValue } from '../../lib/settings-values.js';

function Started(): ReactNode {
  const machine = useMachineQuery().data;
  const session = useClaudeSessionQuery().data;
  const at = machine?.startedAt ?? session?.lastStartedAt ?? null;
  return at === null ? null : <Fact label="Started" value={exactTime(at)} />;
}

function Runner(): ReactNode {
  const session = useClaudeSessionQuery().data;
  const setup = useClaudeSetupQuery().data;
  if (session === undefined) return null;
  return <Fact label="Runner" value={runnerValue(session.legacyRunner, setup?.permissionMode)} />;
}

export function TechnicalGroup({ server }: { server: BoxServer }): ReactNode {
  return (
    <Group label="Technical details">
      <Fact label="Host" value={server.host} copy />
      <Fact label="Agent id" value={server.id} copy />
      {server.instanceId === null ? null : <Fact label="Instance" value={server.instanceId} copy />}
      <Runner />
      <Started />
      {server.instanceId === null ? null : <Item title="Launch log" subtitle="What the server printed while it set itself up" href={routeHash({ kind: 'launch-log', project: server.id })} />}
    </Group>
  );
}
