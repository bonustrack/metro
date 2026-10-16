import { type ReactNode } from 'react';
import { latestLine } from '@metro-labs/client/api/latest-usage';
import { diskLabel, systemLabel, uptimeLabel, type Machine } from '@metro-labs/client/api/machine';
import { type Server } from '@metro-labs/client/api/servers';
import { whenLabel } from '@metro-labs/client/api/when';
import { activeAccount } from '@metro-labs/client/auth/account';
import { Group, Groups } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { Loading } from '../Loading.js';
import { EnrollAgent } from '../EnrollAgent.js';
import { ServerAwsSection } from '../ServerAws.js';
import { ServerResources } from '../ServerResources.js';
import { ServerSizeSection } from '../ServerSize.js';
import { ServerStorageSection } from '../ServerStorage.js';
import { Fact, NoteRow } from './rows.js';
import { useCurrentServer } from './SettingsHome.js';
import { queryError, useClaudeSessionQuery, useLatestUsageQuery, useMachineQuery, useServerStatus } from '../../lib/queries.js';
import { healthValue } from '../../lib/settings-values.js';
import { useTechnicalDetails } from '../../lib/technical.js';
import { useDocumentTitle } from '../../lib/title.js';

function ownerLabel(owner: string | null): string {
  if (owner === null) return 'Not set';
  const account = activeAccount();
  if (account?.organization === owner) return account.organizationName ?? owner;
  return owner;
}

function Health({ server }: { server: Server }): ReactNode {
  const status = useServerStatus(server.host);
  const session = useClaudeSessionQuery();
  const usage = useLatestUsageQuery().data?.[server.id];
  const health = healthValue({ state: status.data?.state, running: session.data?.running, disk: usage?.disk ?? null });
  return (
    <Group label="Health">
      <Item title="Right now" subtitle={usage === undefined ? undefined : latestLine(usage)} value={health.text} valueTone={health.tone} />
    </Group>
  );
}

function MachineGroup({ machine, error }: { machine: Machine | undefined; error: Error | null }): ReactNode {
  if (machine === undefined)
    return <Group label="Machine">{error === null ? <Loading /> : <NoteRow text={queryError(error, 'Could not read this server.')} danger />}</Group>;
  const disk = machine.disk === null ? null : diskLabel(machine.disk);
  return (
    <Group label="Machine">
      <Fact label="Web address" value={machine.publicUrl ?? 'Not online yet'} url={machine.publicUrl ?? undefined} />
      <Fact label="Name" value={machine.hostname} />
      <Fact label="Running for" value={uptimeLabel(machine.uptimeSeconds)} />
      {disk === null ? null : <Fact label="Disk" value={disk.text} tone={disk.full ? 'danger' : undefined} />}
      <Fact label="Owner" value={ownerLabel(machine.owner)} />
    </Group>
  );
}

function Details({ machine, server }: { machine: Machine | undefined; server: Server }): ReactNode {
  return (
    <Group label="Details">
      <Fact label="Agent id" value={server.id} copy />
      <Fact label="Added" value={server.addedAt === '' ? 'Unknown' : whenLabel(server.addedAt)} />
      {machine === undefined ? null : (
        <>
          <Fact label="System" value={systemLabel(machine)} />
          <Fact label="Bun" value={machine.bun ?? 'Unknown'} />
          <Fact label="Local address" value={`http://127.0.0.1:${String(machine.port)}`} />
          <Fact label="Metro files" value={machine.agentsDir} copy />
          <Fact label="Metro program" value={machine.runtimeStore ?? 'Run from source'} />
          <Fact label="Claude Code files" value={machine.claudeDir} copy />
        </>
      )}
    </Group>
  );
}

export function ServerDetails(): ReactNode {
  const { server } = useCurrentServer();
  const machine = useMachineQuery();
  const technical = useTechnicalDetails();
  useDocumentTitle('Server');
  if (server === undefined) return <Loading />;
  return (
    <Groups>
      <Health server={server} />
      <ServerResources serverId={server.id} />
      <ServerSizeSection serverId={server.id} />
      <ServerStorageSection serverId={server.id} />
      <ServerAwsSection server={server} />
      <EnrollAgent server={server} />
      <MachineGroup machine={machine.data} error={machine.error} />
      {technical ? <Details machine={machine.data} server={server} /> : null}
    </Groups>
  );
}
