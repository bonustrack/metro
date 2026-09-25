import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from './ui.js';
import { PageTitle } from './PageTitle.js';
import { FactRow, SettingsGroup } from './SettingsSection.js';
import { Loading } from './Loading.js';
import { MetroVersion } from './MetroVersion.js';
import { DaemonControls } from './DaemonControls.js';
import { ClaudeSession } from './ClaudeSession.js';
import { queryError, useMachineQuery, useServersQuery } from '../api/queries.js';
import { type Server } from '../api/servers.js';
import { diskLabel, systemLabel, uptimeLabel, type Machine } from '../api/machine.js';
import { whenLabel } from '../api/when.js';
import { activeAccount } from '../auth/account.js';
import { useDocumentTitle } from '../title.js';

const FALLBACK = 'Could not read this server.';

function ownerLabel(owner: string | null): string {
  if (owner === null) return 'not set';
  const account = activeAccount();
  if (account?.organization === owner) return account.organizationName ?? owner;
  return owner;
}

function MachineFacts({ machine }: { machine: Machine }): ReactNode {
  return (
    <SettingsGroup title="Machine">
      <FactRow label="Web address" value={machine.publicUrl ?? 'Not online yet'} href={machine.publicUrl ?? undefined} />
      <FactRow label="Name" value={machine.hostname} />
      <FactRow label="Running for" value={uptimeLabel(machine.uptimeSeconds)} />
      {machine.disk === null ? null : <FactRow label="Disk" value={diskLabel(machine.disk).text} danger={diskLabel(machine.disk).full} />}
      <FactRow label="Owner" value={ownerLabel(machine.owner)} />
    </SettingsGroup>
  );
}

function Details({ machine, server }: { machine: Machine | undefined; server: Server | undefined }): ReactNode {
  return (
    <SettingsGroup title="Details">
      {server === undefined ? null : <FactRow label="Agent id" value={server.id} />}
      {server === undefined ? null : <FactRow label="Added" value={server.addedAt === '' ? 'Unknown' : whenLabel(server.addedAt)} />}
      {machine === undefined ? null : (
        <>
          <FactRow label="System" value={systemLabel(machine)} />
          <FactRow label="Bun" value={machine.bun ?? 'Unknown'} />
          <FactRow label="Local address" value={`http://127.0.0.1:${String(machine.port)}`} />
          <FactRow label="Metro files" value={machine.agentsDir} />
          <FactRow label="Metro program" value={machine.runtimeStore ?? 'Run from source'} />
          <FactRow label="Claude Code files" value={machine.claudeDir} />
        </>
      )}
    </SettingsGroup>
  );
}

export function ServerPage({ project }: { project: string }): ReactNode {
  const machine = useMachineQuery();
  const servers = useServersQuery();
  const server = servers.data?.find((s) => s.id === project);
  useDocumentTitle('Server');
  return (
    <Col gap={32}>
      <PageTitle>Server</PageTitle>
      <SettingsGroup title="Metro">
        <MetroVersion />
        <DaemonControls />
      </SettingsGroup>
      <SettingsGroup title="Agent">
        <ClaudeSession project={project} />
      </SettingsGroup>
      {machine.error !== null ? (
        <Text size="sm" role="danger">
          {queryError(machine.error, FALLBACK)}
        </Text>
      ) : machine.data === undefined ? (
        <Loading />
      ) : (
        <MachineFacts machine={machine.data} />
      )}
      <Details machine={machine.data} server={server} />
    </Col>
  );
}
